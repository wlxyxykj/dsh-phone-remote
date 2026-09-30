/**
 * Server tests: routing, the token fence, the loopback-only panel, and the SSE
 * carrier — all against a stub bridge, so no DSH host is needed.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MobileServer, mintToken, addressMatches, isAddressPattern, normalizeAddress } from "../lib/server.js";
import { isPrivateIpv4 } from "../lib/net.js";

const silent = { info() {}, warn() {}, error() {} };

/** Minimal SessionBridge stand-in that records what the server asked for. */
function stubBridge() {
	return {
		calls: [],
		allowsCreate: true,
		allowsCancel: true,
		async listSessions() {
			return [
				{ sessionId: "session-1", title: "写一个插件", cwd: "C:\\work", running: true, blank: false, updatedAt: 1_700_000_000_000 },
				{ sessionId: "session-2", title: "另一个会话", cwd: "D:\\x", running: false, blank: false, updatedAt: 1_600_000_000_000 }
			];
		},
		async createSession(request) {
			this.calls.push(["create", request]);
			return { sessionId: "session-9" };
		},
		async sendPrompt(request) {
			this.calls.push(["prompt", request]);
			return { accepted: true };
		},
		cancel(sessionId) {
			this.calls.push(["cancel", sessionId]);
			return { accepted: true };
		},
		async *follow(request, signal) {
			this.calls.push(["follow", request.sessionId]);
			yield { type: "snapshot", cursor: 3, records: [{ type: "event", event: { type: "user/message", seq: 1, data: { message: { content: [{ type: "text", text: "hi" }] } } } }] };
			yield { type: "assistant-stream", frame: { type: "chunk", chunk: { type: "text-delta", text: "hello" } } };
			await new Promise((resolve) => {
				if (signal.aborted) return resolve();
				signal.addEventListener("abort", resolve, { once: true });
			});
		}
	};
}

/** Start one server on an ephemeral port with the given config overrides. */
async function startServer(bridge, config = {}, access = {}) {
	const server = new MobileServer({
		bridge,
		config: { host: "127.0.0.1", port: 0, exposePanel: true, cwd: "", agentPreset: "", approvalPolicy: "never", allowCreate: true, allowCancel: true, ...config },
		token: "test-token-123",
		statePath: "C:\\state\\dsh-phone-remote.json",
		log: silent,
		access
	});
	const bound = await server.start();
	return { server, base: `http://127.0.0.1:${bound.port}` };
}

describe("phone-remote server", () => {
	let bridge;
	let server;
	let base;

	before(async () => {
		bridge = stubBridge();
		({ server, base } = await startServer(bridge));
	});
	after(async () => {
		await server.stop();
	});

	it("serves the desk panel on loopback", async () => {
		const res = await fetch(`${base}/`);
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /DSH 手机遥控/);
	});

	it("reports panel state with token, urls and sessions", async () => {
		const res = await fetch(`${base}/api/panel/state`);
		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.token, "test-token-123");
		assert.equal(data.defaultCwd, "");
		assert.equal(data.sessions.length, 2);
		assert.ok(Array.isArray(data.urls));
	});

	it("rejects phone API calls without a token", async () => {
		const res = await fetch(`${base}/api/m/state`);
		assert.equal(res.status, 401);
	});

	it("rejects a wrong token", async () => {
		const res = await fetch(`${base}/api/m/state`, { headers: { "x-mobile-token": "nope" } });
		assert.equal(res.status, 401);
	});

	it("accepts the token in a header and returns session state", async () => {
		const res = await fetch(`${base}/api/m/state`, { headers: { "x-mobile-token": "test-token-123" } });
		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.sessions[0].sessionId, "session-1");
		assert.equal(data.allowCreate, true);
	});

	it("accepts ?t= and plants the cookie for later EventSource use", async () => {
		const res = await fetch(`${base}/m?t=test-token-123`, { redirect: "manual" });
		assert.equal(res.status, 200);
		const cookie = res.headers.get("set-cookie") ?? "";
		assert.match(cookie, /mr_token=test-token-123/);
		assert.match(cookie, /HttpOnly/);
		assert.match(await res.text(), /DSH 遥控/);
	});

	it("accepts a cookie-only request", async () => {
		const res = await fetch(`${base}/api/m/state`, { headers: { cookie: "mr_token=test-token-123" } });
		assert.equal(res.status, 200);
	});

	it("serves the phone page's markdown module (no token: it holds no secrets)", async () => {
		const res = await fetch(`${base}/m/markdown.js`);
		assert.equal(res.status, 200, "a cookieless visitor must still be able to load the page module");
		assert.match(res.headers.get("content-type") ?? "", /javascript/);
		assert.match(await res.text(), /export function mdToNodes/);
		const page = await (await fetch(`${base}/m?t=test-token-123`)).text();
		assert.match(page, /from "\/m\/markdown\.js"/);
		// Watchdog: a module that never boots must show a card, never a blank screen.
		assert.match(page, /__mobileRemoteBooted = true/);
		assert.match(page, /id="boot-error"/);
	});

	it("allows its own module in the CSP (an inline module's import is a script fetch)", async () => {
		// Regression guard for the reported black screen: with only 'unsafe-inline'
		// the browser blocks `import "/m/markdown.js"` and nothing renders.
		const csp = (await fetch(`${base}/m`)).headers.get("content-security-policy") ?? "";
		assert.match(csp, /script-src 'self' 'unsafe-inline'/, `got: ${csp}`);
	});

	it("keeps reasoning out of the answer text and offers it collapsed", async () => {
		// Regression guard for the reported bug: thinking must not be rendered as
		// prose, and bold must not print its asterisks. The renderer itself is
		// covered by test/markdown.test.mjs; this pins the phone page's wiring.
		const page = await (await fetch(`${base}/m?t=test-token-123`)).text();
		assert.match(page, /if \(b\.type === "reasoning"\) continue;/, "answer text must skip reasoning blocks");
		assert.match(page, /function reasoningText\(/, "reasoning must be collected separately");
		assert.match(page, /addThinking\(thinking, false\)/, "reasoning must render in a collapsed block");
		assert.match(page, /mdToNodes\(/, "answers must go through the markdown renderer");
		assert.match(page, /\.think summary/, "the collapsed reasoning block needs styling");
	});

	it("forwards a prompt to the bridge", async () => {
		const res = await fetch(`${base}/api/m/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-mobile-token": "test-token-123" },
			body: JSON.stringify({ sessionId: "session-1", text: "把测试跑一遍", timeZone: "Asia/Shanghai" })
		});
		assert.equal(res.status, 200);
		const call = bridge.calls.filter((entry) => entry[0] === "prompt").pop();
		assert.equal(call[1].sessionId, "session-1");
		assert.equal(call[1].text, "把测试跑一遍");
		assert.equal(call[1].timeZone, "Asia/Shanghai");
	});

	it("creates a session", async () => {
		const res = await fetch(`${base}/api/m/create`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-mobile-token": "test-token-123" },
			body: JSON.stringify({ cwd: "C:\\work" })
		});
		assert.equal(res.status, 200);
		assert.equal((await res.json()).sessionId, "session-9");
	});

	it("refuses actions the configuration disabled", async () => {
		const other = stubBridge();
		other.allowsCreate = false;
		other.allowsCancel = false;
		const { server: s2, base: b2 } = await startServer(other, { allowCreate: false, allowCancel: false });
		try {
			const created = await fetch(`${b2}/api/m/create`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-mobile-token": "test-token-123" },
				body: "{}"
			});
			assert.equal(created.status, 403);
			const cancelled = await fetch(`${b2}/api/m/cancel`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-mobile-token": "test-token-123" },
				body: JSON.stringify({ sessionId: "session-1" })
			});
			assert.equal(cancelled.status, 403);
		} finally {
			await s2.stop();
		}
	});

	it("streams follow frames as server-sent events", async () => {
		const controller = new AbortController();
		const res = await fetch(`${base}/api/m/stream?session=session-1`, {
			headers: { "x-mobile-token": "test-token-123" },
			signal: controller.signal
		});
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let received = "";
		while (received.split("\n\n").length < 4) {
			const { value, done } = await reader.read();
			if (done) break;
			received += decoder.decode(value, { stream: true });
		}
		controller.abort();
		assert.match(received, /event: hello/);
		assert.match(received, /"type":"snapshot"/);
		assert.match(received, /text-delta/);
		assert.deepEqual(bridge.calls.filter((entry) => entry[0] === "follow").pop(), ["follow", "session-1"]);
	});

	it("404s unknown paths and refuses non-POST mutations", async () => {
		assert.equal((await fetch(`${base}/nope`)).status, 404);
		const res = await fetch(`${base}/api/m/prompt`, {
			headers: { "x-mobile-token": "test-token-123" }
		});
		assert.equal(res.status, 404);
	});

	it("mints tokens that are URL-safe and unique", () => {
		const seen = new Set();
		for (let i = 0; i < 200; i++) {
			const token = mintToken();
			assert.match(token, /^[a-z2-9]{24}$/);
			seen.add(token);
		}
		assert.equal(seen.size, 200);
	});

	it("rotates the token and invalidates the old one", async () => {
		const rotateBridge = stubBridge();
		const { server: s3, base: b3 } = await startServer(rotateBridge);
		try {
			let rotated = "";
			s3.onRotate = (token) => { rotated = token; };
			const res = await fetch(`${b3}/api/panel/rotate`, { method: "POST" });
			assert.equal(res.status, 200);
			assert.ok(rotated.length > 0);
			const old = await fetch(`${b3}/api/m/state`, { headers: { "x-mobile-token": "test-token-123" } });
			assert.equal(old.status, 401);
			const fresh = await fetch(`${b3}/api/m/state`, { headers: { "x-mobile-token": rotated } });
			assert.equal(fresh.status, 200);
		} finally {
			await s3.stop();
		}
	});

	it("walks forward when the configured port is taken", async () => {
		const first = await startServer(stubBridge());
		const firstPort = Number(new URL(first.base).port);
		const second = await startServer(stubBridge(), { port: firstPort });
		try {
			const secondPort = Number(new URL(second.base).port);
			// The OS may already hold the immediately-following port, so assert the
			// contract (a forward walk inside the 10-port window), not "+1".
			assert.ok(secondPort > firstPort && secondPort < firstPort + 10, `expected a forward walk from ${firstPort}, got ${secondPort}`);
		} finally {
			await second.server.stop();
			await first.server.stop();
		}
	});
});

describe("access control", () => {
	it("treats CGNAT / Tailscale addresses as private", () => {
		assert.equal(isPrivateIpv4("100.64.0.1"), true);
		assert.equal(isPrivateIpv4("100.101.102.103"), true);
		assert.equal(isPrivateIpv4("100.127.255.254"), true);
		assert.equal(isPrivateIpv4("100.63.0.1"), false);
		assert.equal(isPrivateIpv4("100.128.0.1"), false);
		assert.equal(isPrivateIpv4("192.168.1.1"), true);
		assert.equal(isPrivateIpv4("8.8.8.8"), false);
	});

	it("falls back to 0.0.0.0 when the configured host does not exist (Tailscale down)", async () => {
		const server = new MobileServer({
			bridge: stubBridge(),
			// 100.100.100.100 is never assigned locally, so binding must fail.
			config: { host: "100.100.100.100", port: 0, exposePanel: true, cwd: "" },
			token: "test-token-123",
			statePath: "",
			log: silent
		});
		const bound = await server.start();
		try {
			assert.equal(bound.host, "0.0.0.0", "the plugin keeps serving instead of dying");
			assert.equal(server.fellBackToAnyHost, true);
			assert.equal((await fetch(`http://127.0.0.1:${bound.port}/api/panel/state`)).status, 200);
		} finally {
			await server.stop();
		}
	});

	it("normalizes IPv4-mapped addresses", () => {
		assert.equal(normalizeAddress("::ffff:203.0.113.42"), "203.0.113.42");
		assert.equal(normalizeAddress("203.0.113.42"), "203.0.113.42");
		assert.equal(normalizeAddress("::1"), "::1");
	});

	it("accepts exact addresses, dot prefixes and CIDR only", () => {
		assert.equal(isAddressPattern("203.0.113.42"), true);
		assert.equal(isAddressPattern("203.0.113."), true);
		assert.equal(isAddressPattern("203.0.113.0/24"), true);
		assert.equal(isAddressPattern("::1"), true);
		assert.equal(isAddressPattern("203.0.113.42/33"), false);
		assert.equal(isAddressPattern("203.0.113"), false);
		assert.equal(isAddressPattern("not-an-ip"), false);
		assert.equal(isAddressPattern(""), false);
	});

	it("matches an address against the allowlist entries", () => {
		assert.equal(addressMatches("203.0.113.42", "203.0.113.42"), true);
		assert.equal(addressMatches("203.0.113.42", "::ffff:203.0.113.42"), true);
		assert.equal(addressMatches("203.0.113.42", "203.0.113.9"), false);
		assert.equal(addressMatches("203.0.113.", "203.0.113.9"), true);
		assert.equal(addressMatches("203.0.113.", "203.0.114.9"), false);
		assert.equal(addressMatches("203.0.113.0/24", "203.0.113.9"), true);
		assert.equal(addressMatches("203.0.113.0/24", "203.0.114.9"), false);
		assert.equal(addressMatches("0.0.0.0/0", "8.8.8.8"), true);
		assert.equal(addressMatches("::1", "::1"), true);
		assert.equal(addressMatches("::1", "203.0.113.42"), false);
	});

	it("never blocks when disabled or when the list is empty", () => {
		const server = new MobileServer({ config: {}, token: "t", statePath: "", log: silent });
		assert.equal(server.isAllowed("8.8.8.8"), true);
		server.allowEnabled = true;
		assert.equal(server.isAllowed("8.8.8.8"), true, "an enabled but empty list must not lock everyone out");
		server.allowFrom = ["203.0.113.42"];
		assert.equal(server.isAllowed("203.0.113.42"), true);
		assert.equal(server.isAllowed("8.8.8.8"), false);
	});

	it("applies panel actions, persists via callback and refuses config-owned lists", () => {
		const changes = [];
		const server = new MobileServer({
			config: {},
			token: "t",
			statePath: "",
			log: silent,
			access: { enabled: false, ips: [], fromConfig: false },
			onAccessChange: (access) => changes.push(access)
		});
		assert.equal(server.applyAccessAction("allow", "203.0.113.42").ok, true);
		assert.equal(server.allowEnabled, true, "allowing an IP turns the list on");
		assert.deepEqual(server.allowFrom, ["203.0.113.42"]);
		assert.equal(server.applyAccessAction("allow", "203.0.113.42").ok, true, "duplicates are ignored");
		assert.deepEqual(server.allowFrom, ["203.0.113.42"]);
		assert.equal(server.applyAccessAction("allow", "nonsense").ok, false);
		assert.equal(server.applyAccessAction("remove", "203.0.113.42").ok, true);
		assert.deepEqual(server.allowFrom, []);
		assert.equal(server.accessState().enabled, true, "removing the last IP keeps the mode but allows nobody");
		assert.equal(server.isAllowed("8.8.8.8"), true, "an empty list falls back to open");
		assert.equal(server.applyAccessAction("disable").ok, true);
		assert.equal(server.accessState().enabled, false);
		assert.ok(changes.length >= 4, "every change is reported for persistence");

		const owned = new MobileServer({
			config: {},
			token: "t",
			statePath: "",
			log: silent,
			access: { enabled: true, ips: ["10.0.0.1"], fromConfig: true }
		});
		assert.equal(owned.applyAccessAction("allow", "10.0.0.2").ok, false);
		assert.deepEqual(owned.allowFrom, ["10.0.0.1"]);
		assert.equal(owned.applyAccessAction("disable").ok, true, "the master switch stays available");
	});

	it("exposes and edits access state over the loopback panel", async () => {
		const mounted = await startServer(stubBridge());
		try {
			let panel = await (await fetch(`${mounted.base}/api/panel/state`)).json();
			assert.equal(panel.access.enabled, false);
			assert.deepEqual(panel.access.ips, []);

			const allowed = await (await fetch(`${mounted.base}/api/panel/access`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "allow", ip: "203.0.113.42" })
			})).json();
			assert.equal(allowed.ok, true);
			assert.equal(allowed.access.enabled, true);
			assert.deepEqual(allowed.access.ips, ["203.0.113.42"]);

			panel = await (await fetch(`${mounted.base}/api/panel/state`)).json();
			assert.deepEqual(panel.access.ips, ["203.0.113.42"]);

			const bad = await fetch(`${mounted.base}/api/panel/access`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "allow", ip: "not-an-ip" })
			});
			assert.equal(bad.status, 400);

			const cleared = await (await fetch(`${mounted.base}/api/panel/access`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "clear" })
			})).json();
			assert.equal(cleared.access.enabled, false);
			assert.deepEqual(cleared.access.ips, []);
		} finally {
			await mounted.server.stop();
		}
	});

	it("turns away a remote client that is not allowlisted", async () => {
		// Bind every interface and talk to the machine through a non-loopback
		// address, so the request really is a remote one.
		const addresses = Object.values((await import("node:os")).networkInterfaces())
			.flat()
			.filter((info) => info && info.family === "IPv4" && !info.internal && !info.address.startsWith("169.254."));
		if (addresses.length === 0) return; // nothing to test against on this host

		const bridge = stubBridge();
		const server = new MobileServer({
			bridge,
			config: { host: "0.0.0.0", port: 0, exposePanel: true, cwd: "" },
			token: "test-token-123",
			statePath: "",
			log: silent,
			access: { enabled: true, ips: ["203.0.113.7"], fromConfig: false }
		});
		const bound = await server.start();
		let reachable = false;
		try {
			const url = `http://${addresses[0].address}:${bound.port}/api/m/state`;
			let response;
			try {
				response = await fetch(url, { headers: { "x-mobile-token": "test-token-123" }, signal: AbortSignal.timeout(4000) });
				reachable = true;
			} catch {
				return; // the interface is not reachable locally; covered by the unit tests above
			}
			assert.equal(response.status, 403, "a non-allowlisted remote client is refused");
			const body = await response.json();
			assert.match(body.error.message, /未授权/);

			// The panel (loopback) still works and now shows the blocked client.
			const panel = await (await fetch(`http://127.0.0.1:${bound.port}/api/panel/state`)).json();
			assert.equal(panel.access.enabled, true);
			assert.ok(panel.access.recent.some((client) => client.allowed === false), "the blocked client is recorded");

			// Allow it, and the very same request goes through.
			server.applyAccessAction("allow", normalizeAddress(addresses[0].address));
			const after = await fetch(url, { headers: { "x-mobile-token": "test-token-123" }, signal: AbortSignal.timeout(4000) });
			assert.equal(after.status, 200, "allowing the client lets it in without a restart");
		} finally {
			await server.stop();
		}
		assert.equal(reachable, true);
	});
});
