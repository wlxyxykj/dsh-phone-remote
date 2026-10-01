/**
 * dsh-phone-remote — host half.
 *
 * Gives a phone a way to drive the agents running on this computer:
 *
 *   1. the plugin listens on the LAN (its own `node:http` server — the DSH web
 *      GUI binds to loopback and therefore cannot be reached from a phone);
 *   2. it hands out a token-protected link (`http://<lan-ip>:8790/m?t=…`) plus
 *      a QR code on a loopback-only desk panel at `http://127.0.0.1:8790/`;
 *   3. the phone page lists the existing Sessions, sends prompts through
 *      `ctx.sessionController`, and follows the Session log over SSE so the
 *      output streams live and a running turn can be stopped from the phone.
 *
 * Everything is optional-service driven (`ctx.get(...)`) so this plugin never
 * keeps the host from booting when a deployment composes fewer services.
 */

import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { MobileServer, mintToken } from "./server.js";
import { SessionBridge, safeFileName } from "./session.js";
import { statePath, readState, writeState } from "./store.js";
import { listLanAddresses, httpUrl } from "./net.js";

/** Plugin identity for cordis loader rows. */
export const name = "dsh-phone-remote";
/** Hard dependency: without the tool registry the link tool cannot exist. */
export const inject = ["tools"];

/** Default port; busy ports walk forward from here. */
const DEFAULT_PORT = 8790;
/** Largest file the phone may send, or receive from the agent. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Config schema — this is what makes DSH render a settings form for the plugin
 * (without it the entry reports `status: "absent"` and the settings page shows
 * no fields at all).
 *
 * Loaded defensively: `@deepseek-ai/schemastery` ships with DSH, but if it ever
 * cannot be resolved the plugin still starts — it just has no form, and the
 * same keys can still be set from `cordis.patch.yml`.
 */
let Config;
try {
	const { default: z } = await import("@deepseek-ai/schemastery");
	Config = buildConfigSchema(z);
} catch {
	Config = undefined;
}
export { Config };

/**
 * Build the settings-form schema from any schemastery-compatible `z`.
 *
 * Split out from the dynamic import so the exact shape (which keys, which
 * defaults, every field described) is unit-testable even where DSH's
 * `@deepseek-ai/schemastery` is not resolvable.
 *
 * @param z - the schemastery module (or a compatible stub).
 */
export function buildConfigSchema(z) {
	return z.object({
		enabled: z.boolean().default(true).description("关闭后不监听、不注册工具（等同于停用插件）"),
		host: z.string().default("0.0.0.0").description("监听地址。0.0.0.0 = 手机可访问（凭口令）；127.0.0.1 = 仅本机"),
		port: z.natural().max(65535).default(DEFAULT_PORT).description("起始端口，被占用时自动向后顺延（最多 10 个）"),
		token: z.string().default("").description("访问口令。留空 = 复用已保存的，没有就随机生成 24 位"),
		cwd: z.string().default("").description("手机上新建会话时的默认工作目录"),
		agentPreset: z.string().default("").description("手机上新建会话使用的 agent preset（如 standard）"),
		approvalPolicy: z.union([z.const("never"), z.const("ask")]).default("never")
			.description("远程会话的授权策略。never = 不再逐条询问（推荐）；ask = 跟随桌面端弹窗"),
		allowCreate: z.boolean().default(true).description("允许手机新建会话"),
		allowCancel: z.boolean().default(true).description("允许手机叫停正在运行的回合"),
		exposePanel: z.boolean().default(true).description("是否提供仅本机可访问的控制台（http://127.0.0.1:端口/）"),
		allowFrom: z.array(z.string()).default([]).description("IP 白名单，支持 1.2.3.4 / 1.2.3. / 10.0.0.0/8；留空 = 开放（仅凭口令）"),
		strictAllowlist: z.boolean().default(false)
			.description("严格模式：白名单连持有正确口令的设备也拦（名单外的手机必须先在面板允许）。默认关闭 = 口令优先，带对口令的设备换任何网络都能连")
	});
}


/** Coerce the loader-provided config into the shape the plugin uses. */
export function normalizeConfig(input) {
	const raw = input !== null && typeof input === "object" ? input : {};
	const text = (value, fallback = "") => (typeof value === "string" && value.trim() ? value.trim() : fallback);
	const port = Number(raw.port);
	return {
		enabled: raw.enabled !== false,
		host: text(raw.host, "0.0.0.0"),
		port: Number.isInteger(port) && port >= 0 && port < 65536 ? port : DEFAULT_PORT,
		token: text(raw.token),
		cwd: text(raw.cwd),
		agentPreset: text(raw.agentPreset),
		approvalPolicy: raw.approvalPolicy === "ask" ? "ask" : "never",
		allowCreate: raw.allowCreate !== false,
		allowCancel: raw.allowCancel !== false,
		exposePanel: raw.exposePanel !== false,
		/**
		 * Whether the allowlist also turns away clients holding a correct token.
		 * Only the initial default: once the panel records a choice, that wins.
		 */
		strictAllowlist: raw.strictAllowlist === true,
		// Declarative allowlist; when non-empty it wins over the panel-managed one.
		allowFrom: (Array.isArray(raw.allowFrom)
			? raw.allowFrom
			: typeof raw.allowFrom === "string" ? raw.allowFrom.split(",") : [])
			.map((entry) => String(entry).trim())
			.filter((entry) => entry.length > 0)
	};
}

/** Small leveled logger that keeps the plugin's own prefix. */
function createLogger() {
	const write = (level, message) => {
		const line = `[dsh-phone-remote] ${message}`;
		if (level === "error") console.error(line);
		else if (level === "warn") console.warn(line);
		else console.log(line);
	};
	return {
		info: (message) => write("info", message),
		warn: (message) => write("warn", message),
		error: (message) => write("error", message)
	};
}

/** Startup banner with the links a human needs. */
function banner(log, bound, urls, panel, access) {
	const lines = [
		"",
		"  ┌─ DSH 手机遥控已就绪 ─────────────────────────────────",
		`  │ 监听      ${bound.host}:${bound.port}`,
		`  │ 电脑面板  ${panel}`,
		`  │ 访问控制  ${access && access.enabled
			? (access.strict
				? `严格白名单（${access.ips.length} 条）：名单外的设备一律拒绝，即使口令正确`
				: `白名单 ${access.ips.length} 条（口令优先）：带对口令的设备始终放行`)
			: "开放：任何能连到本机的设备都可以打开登录页，凭口令进入"}`,
		"  │ 手机打开："
	];
	if (urls.length === 0) lines.push("  │   （未发现局域网地址，请检查网络）");
	for (const entry of urls.slice(0, 3)) lines.push(`  │   ${entry.url}   ${entry.name}`);
	lines.push("  └──────────────────────────────────────────────────────");
	for (const line of lines) log.info(line);
}

/**
 * Handle of the most recent successful mount.
 *
 * Cordis validates a plugin body's return value as an effect (its resolved
 * value must be a disposer, an iterable of disposers, or nullish), so `apply`
 * must NOT return a handle. Tests and tooling read it here instead.
 */
let lastMount;

/** The most recent `apply` result, for tests and diagnostics. */
export function inspectMount() {
	return lastMount;
}

/**
 * Host loader entry.
 * @param ctx - host cordis context.
 * @param rawConfig - the loader row's `config` object.
 */
export async function apply(ctx, rawConfig = {}) {
	const config = normalizeConfig(rawConfig);
	const log = createLogger();
	if (!config.enabled) {
		log.info("配置为 enabled: false，未启动。");
		return;
	}

	// Reuse the persisted token so the link on the phone keeps working across
	// DSH restarts; mint one on first run or when the config overrides it.
	const persisted = readState();
	const token = config.token
		|| (typeof persisted.token === "string" && persisted.token ? persisted.token : mintToken());
	const fromConfig = config.allowFrom.length > 0;
	const runtimeAccess = {
		enabled: persisted.allowEnabled === true,
		ips: Array.isArray(persisted.allowFrom) ? persisted.allowFrom.filter((entry) => typeof entry === "string") : [],
		// The panel owns this after the first change; config only seeds it.
		strict: typeof persisted.strictAllowlist === "boolean" ? persisted.strictAllowlist : config.strictAllowlist === true
	};
	writeState({
		...persisted,
		token,
		allowEnabled: runtimeAccess.enabled,
		allowFrom: runtimeAccess.ips,
		strictAllowlist: runtimeAccess.strict
	});

	const bridge = new SessionBridge(ctx, config, log);
	const server = new MobileServer({
		bridge,
		config,
		token,
		statePath: statePath(),
		log,
		access: fromConfig
			? { enabled: true, ips: config.allowFrom, fromConfig: true, strict: runtimeAccess.strict }
			: { ...runtimeAccess, fromConfig: false },
		onAccessChange: (access) => {
			// Config owns the list when `allowFrom` is set; the panel cannot edit it then.
			if (fromConfig) return;
			writeState({
				...readState(),
				token: server.token,
				allowEnabled: access.enabled,
				allowFrom: access.ips,
				strictAllowlist: access.strict === true
			});
		}
	});
	server.onRotate = (next) => {
		writeState({ ...readState(), token: next });
		log.info(`访问口令已重置，旧链接立即失效。`);
		banner(log, server.bound, server.urls(), panelUrl(server), server.accessState());
	};

	let bound;
	try {
		bound = await server.start();
	} catch (error) {
		log.error(`启动失败：${error?.message ?? error}`);
		log.error(`请检查端口 ${config.port} 是否被占用，或修改插件配置里的 port。`);
		throw error;
	}

	ctx.effect(() => () => server.stop(), "dsh-phone-remote: listener");

	const urls = server.urls();
	banner(log, bound, urls, panelUrl(server), server.accessState());
	const access = server.accessState();
	if (access.enabled && !access.strict) {
		log.info("白名单为「口令优先」：带对口令的设备（即用带 t= 的完整链接或扫码）始终放行，换网络也不用点允许。");
	} else if (!access.enabled && config.host === "0.0.0.0") {
		log.info("提示：任何能连到本机的设备都能打开登录页，但仍需要口令。");
	}

	registerTool(ctx, { config, server, bridge, log });
	registerSendFileTool(ctx, { server, bridge, log });
	if (typeof ctx.on === "function") {
		ctx.on("dispose", () => log.info("插件已卸载，监听已停止。"));
	}
	lastMount = { server, bridge, bound, urls, config };
	// Deliberately returns nothing: cordis treats a plugin body's resolved value
	// as an effect and rejects anything that is not a disposer/iterable/nullish.
}

/** Loopback panel URL. */
function panelUrl(server) {
	return httpUrl("127.0.0.1", server.bound.port, "/");
}

/** Human-readable byte count for tool output. */
function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The `phone_send_file` tool: the agent pushes one produced file to the phone.
 *
 * The phone is not reachable from the host, so "sending" means registering the
 * file with the HTTP layer and pushing a delivery event down the phone's SSE
 * stream; the phone then shows a download card.
 */
function registerSendFileTool(ctx, options) {
	const { server, bridge, log } = options;
	ctx.effect(() => ctx.tools.register({
		name: "phone_send_file",
		description: [
			"把一个这台电脑上的文件发送到用户的手机：手机页面会出现下载卡片，用户点一下就能保存到手机。",
			"当用户说“把结果发我手机”“这个文件我要下载”“导出/生成的文件发给我”时调用。",
			"path 可以是绝对路径，也可以是相对于当前工作目录的路径（如 dist/report.pdf）；单个文件最大 25 MB。"
		].join(""),
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "要发送的文件路径。" },
				name: { type: "string", description: "手机上显示的文件名（可选，默认用原文件名）。" },
				note: { type: "string", description: "给用户看的一句话说明（可选）。" }
			},
			required: ["path"],
			additionalProperties: false
		},
		output: {
			schema: {
				type: "object",
				properties: { text: { type: "string", description: "给模型和用户看的结果说明。" } },
				required: ["text"],
				additionalProperties: false
			},
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (args, exec) => {
			const requested = typeof args?.path === "string" ? args.path.trim() : "";
			if (!requested) throw new Error("path 不能为空");
			const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : "";
			const cwd = sessionId ? await bridge.sessionCwd(sessionId) : undefined;
			const absolute = isAbsolute(requested) ? requested : resolve(cwd ?? process.cwd(), requested);

			let stat;
			try {
				stat = statSync(absolute);
			} catch {
				throw new Error(`找不到文件：${requested}`);
			}
			if (!stat.isFile()) throw new Error(`不是一个文件：${requested}`);
			if (stat.size > MAX_FILE_BYTES) {
				throw new Error(`文件 ${formatBytes(stat.size)} 超过 25 MB 上限`);
			}

			const fallbackName = absolute.split(/[\\/]/).pop() ?? "file";
			const name = safeFileName(typeof args?.name === "string" && args.name.trim() ? args.name.trim() : fallbackName);
			server.registerDeliverable({
				sessionId,
				path: absolute,
				name,
				bytes: stat.size,
				note: typeof args?.note === "string" && args.note.trim() ? args.note.trim() : undefined
			});
			return { text: `已发送到手机：${name}（${formatBytes(stat.size)}）。手机页面会出现下载卡片，点一下即可保存。` };
		}
	}), "dsh-phone-remote: send-file tool");
	if (log) log.info("已注册工具 phone_send_file。");
}

/**
 * The `phone_remote` tool: lets the agent hand the human the link, or report
 * what the remote surface is doing right now.
 */
function registerTool(ctx, options) {
	const { config, server, bridge, log } = options;
	ctx.effect(() => ctx.tools.register({
		name: "phone_remote",
		description: [
			"给用户生成/查询「手机遥控」链接：用户可以在手机上打开该链接，远程查看会话并指挥这台电脑上的 Agent 干活（发指令、看实时输出、叫停）。",
			"action=link 返回当前可用的手机链接与二维码所在面板地址；action=status 返回监听状态与会话概览。",
			"当用户说“给我手机上用的链接/二维码”“我想在手机上控制电脑”时调用。"
		].join(""),
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["link", "status"],
					description: "link（默认）返回链接；status 返回运行状态。"
				}
			},
			additionalProperties: false
		},
		output: {
			schema: {
				type: "object",
				properties: { text: { type: "string", description: "给模型和用户看的 Markdown 文本。" } },
				required: ["text"],
				additionalProperties: false
			},
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (args) => {
			const action = args && typeof args.action === "string" ? args.action : "link";
			if (action === "status") return { text: await statusText(server, bridge, config) };
			return { text: linkText(server, config) };
		}
	}), "dsh-phone-remote: tool");
	if (log) log.info("已注册工具 phone_remote。");
}

/** Markdown text for `action: link`. */
function linkText(server, config) {
	const urls = server.urls();
	const lines = [
		`## 📱 手机遥控链接`,
		``,
		`手机需要和这台电脑连同一个局域网（Wi-Fi）。用手机相机扫下面的二维码，或直接打开链接：`,
		``,
		`**电脑上打开面板（含二维码，只能本机访问）：** ${panelUrl(server)}`,
		``
	];
	if (urls.length === 0) {
		lines.push("⚠️ 没有发现可用的局域网地址，请检查电脑的网络连接。");
	} else {
		lines.push(...urls.map((entry, index) => `- ${index === 0 ? "**推荐**" : ""} \`${entry.url}\`  （网卡：${entry.name}）`));
	}
	lines.push(
		``,
		`面板地址打开后可以看到二维码，用手机扫一下就能进入。`,
		``,
		`> 链接里的口令就是全部凭证，别截图外发；关闭插件请把配置里的 \`enabled\` 改成 \`false\`。`,
		`> 手机连不上时先检查 Windows 防火墙是否放行了入站 TCP ${server.bound.port}。`
	);
	if (config.host === "0.0.0.0") {
		lines.push(`> 局域网内其他设备只要拿到链接也能操作，公共 Wi-Fi 下建议用完就关。`);
	}
	return lines.join("\n");
}

/** Markdown text for `action: status`. */
async function statusText(server, bridge, config) {
	let sessions = [];
	let error;
	try {
		sessions = await bridge.listSessions();
	} catch (problem) {
		error = problem.message;
	}
	const running = sessions.filter((session) => session.running);
	const access = server.accessState();
	const lines = [
		`## 📱 手机遥控状态`,
		``,
		`- 监听：\`${server.bound.host}:${server.bound.port}\`（${config.host === "0.0.0.0" ? "任何能连到本机的设备都可访问" : "仅本机"}）`,
		`- 访问控制：${access.enabled ? `仅白名单（${access.ips.length} 条）` : "开放（凭口令访问）"}`,
		`- 面板：${panelUrl(server)}`,
		`- 可接管会话：${sessions.length} 个，其中运行中 ${running.length} 个`,
		`- 允许远程新建会话：${bridge.allowsCreate ? "是" : "否"}；允许远程停止：${bridge.allowsCancel ? "是" : "否"}`,
		`- 手机会话授权策略：${config.approvalPolicy === "never" ? "never（不再逐条询问）" : "ask（跟随桌面端应答）"}`
	];
	if (error) lines.push(`- ⚠️ 会话列表读取失败：${error}`);
	if (running.length) {
		lines.push("", "运行中的会话：");
		for (const session of running.slice(0, 8)) lines.push(`- ${session.title}（\`${session.sessionId}\`）`);
	}
	return lines.join("\n");
}

/** Exported for tests: LAN addresses as the panel would show them. */
export { listLanAddresses };
