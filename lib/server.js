/**
 * The phone-facing HTTP server.
 *
 * Two surfaces live on one listener:
 *
 *   • the phone app   — `/m` plus `/api/m/*`, reachable from the LAN, every
 *                       request gated by the access token;
 *   • the desk panel  — `/`, `/api/panel/*`, `/api/qr`, reachable ONLY from
 *                       loopback, so the machine that runs DSH can show the
 *                       link and QR code without that surface being exposed.
 *
 * The DSH web GUI itself binds to 127.0.0.1, which is why a phone cannot use it
 * and why this plugin owns its own listener.
 */

import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { httpUrl, listLanAddresses } from "./net.js";

/** Largest accepted JSON body (kb-scale requests only). */
const MAX_BODY_BYTES = 256 * 1024;
/** Largest file the phone may upload, or download from the computer. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** How long a file the agent pushed to the phone stays downloadable. */
const DELIVERABLE_TTL_MS = 2 * 60 * 60 * 1000;
/** Cap on remembered deliverables, so the map cannot grow without bound. */
const DELIVERABLE_LIMIT = 200;
/** Failed-token attempts tolerated per client address per window. */
const AUTH_FAILURES = 20;
const AUTH_WINDOW_MS = 60_000;
/** Heartbeat interval for SSE streams, so proxies and phones keep them open. */
const HEARTBEAT_MS = 15_000;
/** Cookie name carrying the token after a successful `?t=` visit. */
const COOKIE = "mr_token";

const HTML = {
	app: readFileSync(new URL("./app.html", import.meta.url), "utf8"),
	panel: readFileSync(new URL("./panel.html", import.meta.url), "utf8")
};

/** Client-side ESM assets served next to the phone page. */
const ASSETS = {
	"/m/markdown.js": {
		body: readFileSync(new URL("./markdown.js", import.meta.url), "utf8"),
		type: "text/javascript; charset=utf-8"
	}
};

/** Whether an address is this machine's loopback. */
function isLoopback(address) {
	if (!address) return false;
	const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
	return normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.");
}

/** Strip the IPv4-mapped IPv6 prefix Node reports for IPv4 clients. */
export function normalizeAddress(address) {
	const raw = String(address ?? "").trim();
	return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
}

/** Whether an allowlist entry is a usable address, prefix, or CIDR. */
export function isAddressPattern(entry) {
	if (typeof entry !== "string") return false;
	const value = entry.trim();
	if (value.length === 0 || value.length > 64) return false;
	if (isIpv4(value) || value.includes(":")) return true; // exact IPv4 / IPv6
	if (value.endsWith(".")) return isIpv4Prefix(value.slice(0, -1)); // "203.0.113."
	const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value);
	return cidr !== null && isIpv4(cidr[1]) && Number(cidr[2]) <= 32;
}

/** Whether a string is 2–4 numeric IPv4 octets (the head of a dot prefix). */
function isIpv4Prefix(value) {
	const parts = value.split(".");
	if (parts.length < 2 || parts.length > 4) return false;
	return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Whether two strings form a dotted-quad IPv4 address. */
function isIpv4(value) {
	const parts = value.split(".");
	if (parts.length !== 4) return false;
	return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** IPv4 literal as an unsigned 32-bit integer. */
function ipv4ToInt(value) {
	return value.split(".").reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0) >>> 0;
}

/** Whether one allowlist entry admits one client address. */
export function addressMatches(entry, address) {
	const candidate = normalizeAddress(address);
	const pattern = String(entry ?? "").trim();
	if (pattern.length === 0) return false;
	if (pattern === candidate) return true;
	if (candidate.includes(":")) return false; // IPv6 matches exactly only
	if (pattern.endsWith(".")) return candidate.startsWith(pattern);
	const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(pattern);
	if (cidr && isIpv4(cidr[1]) && isIpv4(candidate)) {
		const bits = Number(cidr[2]);
		if (bits === 0) return true;
		const mask = (0xffffffff << (32 - bits)) >>> 0;
		return (ipv4ToInt(cidr[1]) & mask) >>> 0 === (ipv4ToInt(candidate) & mask) >>> 0;
	}
	return false;
}

/** Constant-time token comparison that leaks neither length nor prefix. */
function tokenMatches(expected, candidate) {
	if (typeof candidate !== "string" || candidate.length === 0) return false;
	const a = createHash("sha256").update(expected).digest();
	const b = createHash("sha256").update(candidate).digest();
	return timingSafeEqual(a, b);
}

/** Mint a base32 token (~120 bits) that is safe to type on a phone. */
export function mintToken() {
	const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
	const bytes = randomBytes(24);
	let out = "";
	for (let i = 0; i < 24; i++) out += alphabet[bytes[i] % alphabet.length];
	return out;
}

export class MobileServer {
	/**
	 * @param options - `{ bridge, config, token, statePath, log, access, onAccessChange }`.
	 *   `access` is `{ enabled, ips, fromConfig }`; `onAccessChange` persists a change.
	 */
	constructor(options) {
		this.bridge = options.bridge;
		this.config = options.config;
		this.token = options.token;
		this.statePath = options.statePath;
		this.log = options.log;
		this.server = undefined;
		this.bound = { host: "", port: 0 };
		this.connections = new Set();
		this.failures = new Map();
		const access = options.access ?? {};
		/** Whether the remote surface is restricted to `allowFrom`. */
		this.allowEnabled = access.enabled === true;
		/** Allowed client addresses (exact IPv4/IPv6, a `1.2.3.` prefix, or CIDR). */
		this.allowFrom = Array.isArray(access.ips) ? access.ips.map(String) : [];
		/** True when the list comes from configuration (panel edits are refused). */
		this.allowFromConfig = access.fromConfig === true;
		/** Recently seen remote clients, for the loopback panel. */
		this.clients = new Map();
		/** Files the agent pushed to the phone: id → entry. */
		this.deliverables = new Map();
		/** Live SSE writers, so a tool call can reach the phone immediately. */
		this.subscribers = new Set();
		this.onAccessChange = typeof options.onAccessChange === "function" ? options.onAccessChange : undefined;
	}

	/**
	 * Remember one file the agent wants the phone to download, and push it to
	 * every open phone stream.
	 * @param entry - `{ sessionId, path, name, bytes, note }`.
	 * @returns the deliverable id.
	 */
	registerDeliverable(entry) {
		const id = randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || randomBytes(8).toString("hex");
		const record = {
			id,
			sessionId: String(entry.sessionId ?? ""),
			path: String(entry.path),
			name: String(entry.name ?? "file"),
			bytes: Number(entry.bytes ?? 0),
			note: entry.note === undefined ? undefined : String(entry.note),
			time: Date.now()
		};
		this.deliverables.set(id, record);
		this.#pruneDeliverables();
		this.publish("deliverable", { id, name: record.name, bytes: record.bytes, note: record.note, sessionId: record.sessionId, time: record.time });
		return id;
	}

	/** Deliverables still inside the TTL, newest first. */
	listDeliverables(sessionId) {
		this.#pruneDeliverables();
		return [...this.deliverables.values()]
			.filter((entry) => sessionId === undefined || entry.sessionId === sessionId)
			.sort((left, right) => right.time - left.time)
			.map((entry) => ({ id: entry.id, name: entry.name, bytes: entry.bytes, note: entry.note, sessionId: entry.sessionId, time: entry.time }));
	}

	/** Forward one plugin event to every open phone stream. */
	publish(event, payload) {
		for (const write of this.subscribers) {
			try {
				write(event, payload);
			} catch {
				/* a dead stream removes itself on close */
			}
		}
	}

	#pruneDeliverables() {
		const cutoff = Date.now() - DELIVERABLE_TTL_MS;
		for (const [id, entry] of this.deliverables) {
			if (entry.time < cutoff) this.deliverables.delete(id);
		}
		while (this.deliverables.size > DELIVERABLE_LIMIT) {
			const oldest = [...this.deliverables.values()].sort((left, right) => left.time - right.time)[0];
			if (!oldest) break;
			this.deliverables.delete(oldest.id);
		}
	}

	/** Current access-control state, as the panel shows it. */
	accessState() {
		const recent = [...this.clients.entries()]
			.map(([ip, info]) => ({ ip, lastSeen: info.lastSeen, hits: info.hits, allowed: info.allowed }))
			.sort((left, right) => right.lastSeen - left.lastSeen)
			.slice(0, 24);
		return {
			enabled: this.allowEnabled,
			fromConfig: this.allowFromConfig,
			ips: this.allowFrom.slice(),
			recent
		};
	}

	/**
	 * Apply one panel access action.
	 * @param action - `allow` | `remove` | `enable` | `disable` | `clear`.
	 * @param ip - address for `allow` / `remove`.
	 */
	applyAccessAction(action, ip) {
		if (this.allowFromConfig && action !== "enable" && action !== "disable") {
			return { ok: false, error: "白名单由插件配置 allowFrom 管理，请改配置而不是在面板上改。" };
		}
		const address = typeof ip === "string" ? normalizeAddress(ip) : "";
		if (action === "allow") {
			if (!isAddressPattern(address)) return { ok: false, error: `不是有效的 IP 或网段：${ip}` };
			if (!this.allowFrom.includes(address)) this.allowFrom.push(address);
			this.allowEnabled = true;
		} else if (action === "remove") {
			this.allowFrom = this.allowFrom.filter((entry) => entry !== address);
		} else if (action === "enable") {
			this.allowEnabled = true;
		} else if (action === "disable") {
			this.allowEnabled = false;
		} else if (action === "clear") {
			this.allowFrom = [];
			this.allowEnabled = false;
		} else {
			return { ok: false, error: `未知操作：${action}` };
		}
		// Drop stale "blocked" marks so the panel reflects the new decision.
		for (const [key, info] of this.clients) info.allowed = this.isAllowed(key);
		if (this.onAccessChange) this.onAccessChange(this.accessState());
		return { ok: true, access: this.accessState() };
	}

	/** Whether one client address may use the remote surface. */
	isAllowed(address) {
		if (!this.allowEnabled) return true;
		if (this.allowFrom.length === 0) return true; // an empty list must not lock everyone out
		return this.allowFrom.some((entry) => addressMatches(entry, address));
	}

	/** Record one remote client for the panel. */
	#noteClient(address, allowed) {
		const info = this.clients.get(address);
		if (info) {
			info.lastSeen = Date.now();
			info.hits += 1;
			info.allowed = allowed;
		} else {
			if (this.clients.size >= 200) {
				const oldest = [...this.clients.entries()].sort((left, right) => left[1].lastSeen - right[1].lastSeen)[0];
				if (oldest) this.clients.delete(oldest[0]);
			}
			this.clients.set(address, { lastSeen: Date.now(), hits: 1, allowed });
		}
	}

	/** LAN URLs a phone can open, best candidate first. */
	urls() {
		const host = this.bound.host;
		const port = this.bound.port;
		const addresses = listLanAddresses();
		const list = [];
		const seen = new Set();
		for (const entry of addresses) {
			if (seen.has(entry.address)) continue;
			seen.add(entry.address);
			list.push({
				address: entry.address,
				name: entry.name,
				primary: list.length === 0,
				url: `${httpUrl(entry.address, port, "/m")}?t=${this.token}`
			});
		}
		// A hostname-based URL still helps when the phone resolves mDNS/DNS for
		// this machine; it is never the primary candidate.
		if (host !== "0.0.0.0" && host !== "::") {
			list.unshift({
				address: host,
				name: "configured host",
				primary: true,
				url: `${httpUrl(host, port, "/m")}?t=${this.token}`
			});
		}
		return list;
	}

	/**
	 * Listen, walking forward from the configured port when it is taken.
	 *
	 * A configured host that does not exist yet (typically a Tailscale/VPN
	 * address while the tunnel is down at boot) falls back to `0.0.0.0` instead
	 * of failing the whole plugin — the access allowlist is then the fence.
	 *
	 * @returns the bound `{ host, port }`.
	 */
	async start() {
		const requested = this.config.host;
		const hosts = requested === "0.0.0.0" || requested === "::" ? [requested] : [requested, "0.0.0.0"];
		let lastError;
		for (const host of hosts) {
			for (let port = this.config.port; port < this.config.port + 10; port++) {
				try {
					const bound = await this.#listen(host, port);
					this.bound = bound;
					if (host !== requested) {
						this.fellBackToAnyHost = true;
						this.log.warn(`[phone-remote] 配置的监听地址 ${requested} 当前不可用（Tailscale/VPN 没起来？），已退回 0.0.0.0:${port}；请用访问控制白名单兜底。`);
					}
					return this.bound;
				} catch (error) {
					lastError = error;
					// The address is missing → try the next host (same port base).
					if (error && error.code === "EADDRNOTAVAIL") break;
					if (error && (error.code === "EADDRINUSE" || error.code === "EACCES")) continue;
					throw error;
				}
			}
		}
		throw new Error(`无法监听 ${requested}：${lastError?.message ?? lastError}`);
	}

	/** One listen attempt; resolves to the port actually bound. */
	#listen(host, port) {
		return new Promise((resolve, reject) => {
			const server = createServer((req, res) => {
				this.#dispatch(req, res).catch((error) => {
					this.log.warn(`[phone-remote] 请求处理失败：${error?.stack ?? error}`);
					if (!res.headersSent) this.#json(res, 500, { error: { code: "internal", message: String(error?.message ?? error) } });
					else res.end();
				});
			});
			// Track sockets so stop() can close keep-alive/SSE connections fast.
			server.on("connection", (socket) => {
				this.connections.add(socket);
				socket.on("close", () => this.connections.delete(socket));
			});
			server.on("error", (error) => {
				server.removeAllListeners();
				reject(error);
			});
			server.listen({ host, port, exclusive: true }, () => {
				const address = server.address();
				this.server = server;
				resolve({ host, port: typeof address === "object" && address ? address.port : port });
			});
		});
	}

	/** Close the listener and every open stream. */
	async stop() {
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		for (const socket of this.connections) socket.destroy();
		this.connections.clear();
		await new Promise((resolve) => server.close(() => resolve()));
	}

	/** Replace the access token (panel action); returns the new token. */
	rotate() {
		this.token = mintToken();
		return this.token;
	}

	// ── routing ────────────────────────────────────────────────────────────

	async #dispatch(req, res) {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname;
		const remote = normalizeAddress(req.socket.remoteAddress);
		const loopback = isLoopback(remote);

		this.#security(res, loopback);

		// Access control comes before routing: the panel is the only remote-side
		// surface that always works, and it is loopback-only anyway.
		if (!loopback) {
			const allowed = this.isAllowed(remote);
			this.#noteClient(remote, allowed);
			if (!allowed) return this.#denied(res);
		}

		// Desk panel: never served off-box.
		if (path === "/" || path === "/index.html" || path === "/panel") {
			if (!loopback || this.config.exposePanel === false) return this.#notFound(res);
			return this.#html(res, HTML.panel, "no-store");
		}
		if (path === "/api/panel/state" && req.method === "GET") {
			if (!loopback) return this.#notFound(res);
			return this.#panelState(res);
		}
		if (path === "/api/panel/rotate" && req.method === "POST") {
			if (!loopback) return this.#notFound(res);
			return this.#panelRotate(res);
		}
		if (path === "/api/panel/access" && req.method === "POST") {
			if (!loopback) return this.#notFound(res);
			return this.#panelAccess(req, res);
		}
		if (path === "/api/qr" && req.method === "GET") {
			if (!loopback) return this.#notFound(res);
			return this.#qr(res, url);
		}

		// Phone app: static shell + its client-side module, then token-gated APIs.
		const asset = ASSETS[path];
		if (asset) {
			// Static client code, no secrets in it: the phone page must be able to
			// load its module even before/without a token, otherwise a visitor
			// without a cookie would get a blank page instead of the token gate.
			// Everything that touches sessions stays behind `#authorize`.
			return this.#asset(res, asset);
		}
		if (path === "/m" || path === "/m/" || path === "/mobile") {
			if (this.#authorize(req, url, res)) this.#setCookie(res);
			return this.#html(res, HTML.app);
		}
		if (path.startsWith("/api/m/")) {
			if (!this.#rateOk(req.socket.remoteAddress)) {
				return this.#json(res, 429, { error: { code: "rate-limited", message: "尝试过于频繁，请稍后再试" } });
			}
			if (!this.#authorize(req, url, res)) {
				this.#noteFailure(req.socket.remoteAddress);
				return this.#json(res, 401, { error: { code: "unauthorized", message: "访问口令无效" } });
			}
			this.#setCookie(res);
			return this.#mobile(req, res, url, path);
		}
		return this.#notFound(res);
	}

	#security(res, loopback) {
		res.setHeader("x-content-type-options", "nosniff");
		res.setHeader("referrer-policy", "no-referrer");
		res.setHeader("cross-origin-resource-policy", "same-origin");
		// `'self'` is required: the phone page is an inline MODULE, and its
		// `import "/m/markdown.js"` is an external script fetch that `script-src`
		// governs — with only 'unsafe-inline' the browser blocks the import and
		// the whole page stays blank.
		res.setHeader("content-security-policy", loopback
			? "default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'none'; base-uri 'none'"
			: "default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
	}

	// ── auth ───────────────────────────────────────────────────────────────

	#authorize(req, url, res) {
		const header = req.headers["x-mobile-token"];
		if (typeof header === "string" && tokenMatches(this.token, header)) return true;
		const auth = req.headers.authorization;
		if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
			if (tokenMatches(this.token, auth.slice(7).trim())) return true;
		}
		const query = url.searchParams.get("t");
		if (query && tokenMatches(this.token, query)) {
			if (res) this.#setCookie(res);
			return true;
		}
		const cookies = parseCookies(req.headers.cookie);
		if (cookies[COOKIE] && tokenMatches(this.token, cookies[COOKIE])) return true;
		return false;
	}

	#setCookie(res) {
		if (!res || res.headersSent) return;
		res.setHeader("set-cookie", `${COOKIE}=${this.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
	}

	#noteFailure(address) {
		const key = address ?? "?";
		const now = Date.now();
		const entry = this.failures.get(key);
		if (!entry || now - entry.start > AUTH_WINDOW_MS) this.failures.set(key, { start: now, count: 1 });
		else entry.count += 1;
	}

	#rateOk(address) {
		const entry = this.failures.get(address ?? "?");
		if (!entry) return true;
		if (Date.now() - entry.start > AUTH_WINDOW_MS) {
			this.failures.delete(address ?? "?");
			return true;
		}
		return entry.count < AUTH_FAILURES;
	}

	// ── panel endpoints ────────────────────────────────────────────────────

	async #panelState(res) {
		let sessions = [];
		try {
			sessions = await this.bridge.listSessions();
		} catch (error) {
			this.log.warn(`[phone-remote] ${error.message}`);
		}
		this.#json(res, 200, {
			host: this.bound.host,
			port: this.bound.port,
			token: this.token,
			urls: this.urls(),
			statePath: this.statePath,
			defaultCwd: this.config.cwd || "",
			access: this.accessState(),
			sessions
		});
	}

	/** Apply one access-control action from the loopback panel. */
	async #panelAccess(req, res) {
		const body = await this.#body(req, res);
		if (body === undefined) return;
		const result = this.applyAccessAction(String(body?.action ?? ""), body?.ip);
		if (!result.ok) return this.#json(res, 400, { error: { code: "bad-request", message: result.error } });
		this.log.info(`[phone-remote] 访问控制更新：白名单${result.access.enabled ? "已启用" : "已关闭"}，共 ${result.access.ips.length} 条。`);
		this.#json(res, 200, { ok: true, access: result.access });
	}

	/** Refuse a client that is not on the allowlist (no detail, no oracle). */
	#denied(res) {
		if (res.writableEnded) return;
		res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify({ error: { code: "forbidden", message: "此设备未授权访问，请在电脑端面板 (http://127.0.0.1:" + this.bound.port + "/) 里允许它的 IP。" } }));
	}

	#panelRotate(res) {
		const token = this.rotate();
		if (typeof this.onRotate === "function") this.onRotate(token);
		this.#json(res, 200, { token, urls: this.urls() });
	}

	async #qr(res, url) {
		const text = url.searchParams.get("text");
		if (!text || text.length > 512) {
			return this.#json(res, 400, { error: { code: "bad-request", message: "text missing or too long" } });
		}
		try {
			// Lazy so a broken/absent QR module can never take the plugin down:
			// the link and the copy button still work without a QR code.
			if (!this.qrModule) this.qrModule = import("./qr.js");
			const { qrMatrix } = await this.qrModule;
			const matrix = qrMatrix(text, { ecLevel: "M" });
			const rows = matrix.modules.map((row) => Array.from(row, (cell) => (cell ? "1" : "0")).join(""));
			this.#json(res, 200, { size: matrix.size, version: matrix.version, ecLevel: matrix.ecLevel, rows });
		} catch (error) {
			this.#json(res, 400, { error: { code: "qr-failed", message: String(error?.message ?? error) } });
		}
	}

	// ── phone endpoints ────────────────────────────────────────────────────

	async #mobile(req, res, url, path) {
		if (path === "/api/m/state" && req.method === "GET") {
			let sessions = [];
			let error;
			try {
				sessions = await this.bridge.listSessions();
			} catch (problem) {
				error = problem.message;
			}
			return this.#json(res, 200, {
				sessions,
				defaultCwd: this.config.cwd || "",
				allowCreate: this.bridge.allowsCreate,
				allowCancel: this.bridge.allowsCancel,
				deliverables: this.listDeliverables(),
				error
			});
		}
		if (path === "/api/m/create" && req.method === "POST") {
			if (!this.bridge.allowsCreate) {
				return this.#json(res, 403, { error: { code: "forbidden", message: "本机配置不允许远程新建会话" } });
			}
			const body = await this.#body(req, res);
			if (body === undefined) return;
			try {
				return this.#json(res, 200, await this.bridge.createSession(body ?? {}));
			} catch (error) {
				return this.#json(res, 400, { error: { code: "create-failed", message: error.message } });
			}
		}
		if (path === "/api/m/prompt" && req.method === "POST") {
			const body = await this.#body(req, res);
			if (body === undefined) return;
			try {
				return this.#json(res, 200, await this.bridge.sendPrompt(body ?? {}));
			} catch (error) {
				return this.#json(res, 400, { error: { code: "prompt-failed", message: error.message } });
			}
		}
		if (path === "/api/m/cancel" && req.method === "POST") {
			if (!this.bridge.allowsCancel) {
				return this.#json(res, 403, { error: { code: "forbidden", message: "本机配置不允许远程停止" } });
			}
			const body = await this.#body(req, res);
			if (body === undefined) return;
			try {
				return this.#json(res, 200, this.bridge.cancel(body?.sessionId));
			} catch (error) {
				return this.#json(res, 400, { error: { code: "cancel-failed", message: error.message } });
			}
		}
		if (path === "/api/m/stream" && req.method === "GET") {
			return this.#stream(req, res, url);
		}
		if (path === "/api/m/upload" && req.method === "POST") {
			return this.#upload(req, res, url);
		}
		if (path.startsWith("/api/m/download/") && req.method === "GET") {
			return this.#download(res, decodeURIComponent(path.slice("/api/m/download/".length)));
		}
		return this.#notFound(res);
	}

	/**
	 * Accept one file from the phone and hand it to the bridge, which writes it
	 * into the session's working directory so the agent can just read it.
	 * The body is the raw file; the name rides in `?name=`.
	 */
	async #upload(req, res, url) {
		const sessionId = url.searchParams.get("session");
		if (!sessionId) return this.#json(res, 400, { error: { code: "bad-request", message: "缺少 session 参数" } });
		const name = url.searchParams.get("name") ?? "file";
		const declared = Number(req.headers["content-length"] ?? 0);
		if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
			return this.#json(res, 413, { error: { code: "file-too-large", message: `文件超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB 上限` } });
		}
		try {
			const saved = await this.bridge.saveUpload(sessionId, name, req, MAX_FILE_BYTES);
			this.log.info(`[phone-remote] 收到手机上传：${saved.name} → ${saved.path}`);
			return this.#json(res, 200, { ok: true, ...saved });
		} catch (error) {
			const status = error?.code === "file-too-large" ? 413 : 400;
			return this.#json(res, status, { error: { code: "upload-failed", message: String(error?.message ?? error) } });
		}
	}

	/** Stream one file the agent pushed to the phone. */
	#download(res, id) {
		this.#pruneDeliverables();
		const entry = this.deliverables.get(id);
		if (!entry) return this.#json(res, 404, { error: { code: "not-found", message: "文件不存在或已过期" } });
		let stat;
		try {
			stat = statSync(entry.path);
		} catch {
			return this.#json(res, 410, { error: { code: "gone", message: "原文件已被移动或删除" } });
		}
		if (!stat.isFile()) return this.#json(res, 410, { error: { code: "gone", message: "这不是一个文件" } });
		if (stat.size > MAX_FILE_BYTES) {
			return this.#json(res, 413, { error: { code: "file-too-large", message: `文件超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB 上限` } });
		}
		res.writeHead(200, {
			"content-type": contentTypeOf(entry.name),
			"content-length": stat.size,
			"content-disposition": contentDisposition(entry.name),
			"cache-control": "no-store"
		});
		const stream = createReadStream(entry.path);
		stream.on("error", () => res.destroy());
		stream.pipe(res);
	}

	/** Server-sent events carrying the Session's follow frames. */
	async #stream(req, res, url) {
		const sessionId = url.searchParams.get("session");
		if (!sessionId) return this.#json(res, 400, { error: { code: "bad-request", message: "缺少 session 参数" } });

		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			"connection": "keep-alive",
			"x-accel-buffering": "no"
		});
		res.write("retry: 3000\n\n");
		const write = (event, data) => {
			if (res.writableEnded) return;
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		};
		write("hello", { sessionId, serverTime: Date.now() });
		// Replayed deliverables, so a refresh does not lose a file the agent sent.
		const pending = this.listDeliverables();
		if (pending.length > 0) write("deliverables", pending);
		this.subscribers.add(write);

		const abort = new AbortController();
		req.on("close", () => abort.abort());
		const heartbeat = setInterval(() => {
			if (!res.writableEnded) res.write(": ping\n\n");
		}, HEARTBEAT_MS);

		try {
			for await (const frame of this.bridge.follow({ sessionId }, abort.signal)) {
				write("frame", frame);
			}
			write("notice", { level: "info", message: "会话流已结束" });
		} catch (error) {
			if (!abort.signal.aborted) {
				write("notice", { level: "error", message: `订阅失败：${error?.message ?? error}` });
			}
		} finally {
			this.subscribers.delete(write);
			clearInterval(heartbeat);
			res.end();
		}
	}

	// ── helpers ────────────────────────────────────────────────────────────

	/** Read and parse a JSON body; `undefined` means a response was already sent. */
	async #body(req, res) {
		const declared = Number(req.headers["content-length"] ?? 0);
		if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
			this.#json(res, 413, { error: { code: "payload-too-large", message: "请求体过大" } });
			return undefined;
		}
		const chunks = [];
		let size = 0;
		try {
			for await (const chunk of req) {
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					this.#json(res, 413, { error: { code: "payload-too-large", message: "请求体过大" } });
					req.destroy();
					return undefined;
				}
				chunks.push(chunk);
			}
		} catch {
			return undefined;
		}
		const raw = Buffer.concat(chunks).toString("utf8");
		if (!raw.trim()) return {};
		try {
			const parsed = JSON.parse(raw);
			return parsed !== null && typeof parsed === "object" ? parsed : {};
		} catch {
			this.#json(res, 400, { error: { code: "bad-json", message: "请求体不是合法 JSON" } });
			return undefined;
		}
	}

	#json(res, status, value) {
		if (res.writableEnded) return;
		const body = JSON.stringify(value);
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(body);
	}

	#html(res, html, cache = "no-cache") {
		if (res.writableEnded) return;
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": cache });
		res.end(html);
	}

	#asset(res, asset) {
		if (res.writableEnded) return;
		res.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache" });
		res.end(asset.body);
	}

	#notFound(res) {
		this.#json(res, 404, { error: { code: "not-found", message: "not found" } });
	}
}

/** Parse a `Cookie` header into a plain object. */
function parseCookies(header) {
	const out = {};
	if (typeof header !== "string") return out;
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index < 0) continue;
		out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
	}
	return out;
}

/** Content types worth naming; everything else is an opaque download. */
const CONTENT_TYPES = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	pdf: "application/pdf",
	txt: "text/plain; charset=utf-8",
	md: "text/markdown; charset=utf-8",
	csv: "text/csv; charset=utf-8",
	json: "application/json; charset=utf-8",
	html: "text/html; charset=utf-8",
	zip: "application/zip",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};

/** Best-effort content type for a download. */
function contentTypeOf(name) {
	const extension = String(name).toLowerCase().split(".").pop() ?? "";
	return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/** `Content-Disposition` that survives non-ASCII names in every browser. */
function contentDisposition(name) {
	const ascii = String(name).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
