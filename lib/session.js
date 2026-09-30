/**
 * Session bridge: the thin layer between the plugin and the DSH host services
 * that own Sessions and Agents.
 *
 * Everything the phone can do goes through here, so this is the one place that
 * has to know the host API. Each call is defensive: a missing service or a
 * changed signature must produce a readable message in the mobile UI instead of
 * an unhandled rejection inside the DSH host process.
 */

import { createWriteStream, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { dshHome } from "./store.js";

/** Where uploads land inside a session's working directory. */
const UPLOAD_DIR = ".phone-uploads";

/** Extract the plain text of a prompt/message content block array. */
export function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const out = [];
	for (const block of content) {
		if (!block) continue;
		if (typeof block.text === "string") out.push(block.text);
	}
	return out.join("\n");
}

/** Strip anything that could escape a directory or break a filesystem call. */
export function safeFileName(raw) {
	const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
	const cleaned = base
		.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
		.replace(/^\.+/, "")
		.trim();
	const limited = cleaned.slice(0, 120);
	return limited.length > 0 ? limited : "file";
}

/** `20260930-215900`, so two files with the same name never collide. */
function stamp() {
	const now = new Date();
	const pad = (value) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Human-readable message for any thrown value. */
function reason(error) {
	if (error === null || error === undefined) return "unknown error";
	if (typeof error === "string") return error;
	if (typeof error.message === "string") return error.message;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

export class SessionBridge {
	/**
	 * @param ctx - host cordis context.
	 * @param options - `{ cwd, agentPreset, approvalPolicy }`.
	 * @param log - logger `{ info, warn, error }`.
	 */
	constructor(ctx, options, log) {
		this.ctx = ctx;
		this.options = options;
		this.log = log;
	}

	/** The session-control service, or undefined when this deployment lacks it. */
	get controller() {
		return this.ctx.get("sessionController");
	}

	/** Require the session-control service. */
	requireController() {
		const controller = this.controller;
		if (!controller) throw new Error("sessionController 服务不可用：无法驱动会话");
		return controller;
	}

	/**
	 * Sessions a phone may take over: top-level, most recently active first.
	 * @param signal - cancellation for persistence reads.
	 */
	async listSessions(signal) {
		const controller = this.controller;
		if (!controller) return [];
		let value;
		try {
			value = await controller.list({}, signal);
		} catch (error) {
			// A pre-aborted signal is not an error worth surfacing.
			if (signal?.aborted) return [];
			throw new Error(`读取会话列表失败：${reason(error)}`);
		}
		const items = Array.isArray(value?.items) ? value.items : [];
		return items
			.filter((item) => item && item.origin !== "subagent")
			.map((item) => ({
				sessionId: String(item.sessionId),
				title: titleOf(item),
				cwd: typeof item.cwd === "string" ? item.cwd : "",
				running: item.running === true,
				blank: item.blank === true,
				updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0
			}))
			.sort((left, right) => {
				if (left.blank !== right.blank) return left.blank ? 1 : -1;
				return right.updatedAt - left.updatedAt;
			});
	}

	/**
	 * Create one ordinary Session and return its id.
	 * @param request - `{ cwd?, agentPreset? }`.
	 */
	async createSession(request = {}) {
		const controller = this.requireController();
		const cwd = typeof request.cwd === "string" && request.cwd.trim().length > 0
			? request.cwd.trim()
			: (this.options.cwd || undefined);
		const agentPreset = typeof request.agentPreset === "string" && request.agentPreset.trim().length > 0
			? request.agentPreset.trim()
			: (this.options.agentPreset || undefined);
		let value;
		try {
			value = await controller.create({ cwd, agentPreset });
		} catch (error) {
			throw new Error(`新建会话失败：${reason(error)}`);
		}
		if (!value || !value.sessionId) throw new Error("新建会话失败：服务未返回会话 id");
		const id = String(value.sessionId);

		// A brand-new Session has no Agent yet. Resuming it here is what makes
		// the per-session approval policy stick BEFORE the first prompt runs,
		// so the phone never has to answer an approval prompt it cannot see.
		await this.#installPolicy(id);
		return { sessionId: id, agentPreset: value.agentPreset ? String(value.agentPreset) : undefined };
	}

	/**
	 * Send one text prompt to a Session, resuming its Agent if needed.
	 * @param request - `{ sessionId, text, mode?, timeZone? }`.
	 */
	async sendPrompt(request) {
		const controller = this.requireController();
		const sessionId = String(request.sessionId || "");
		const text = String(request.text ?? "");
		if (!sessionId) throw new Error("缺少会话 id");
		if (!text.trim()) throw new Error("内容为空");
		const mode = request.mode === "steer" ? "steer" : "queue";

		await this.#installPolicy(sessionId);

		const prompt = {
			requestId: `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			sessionId,
			mode,
			content: [{ type: "text", text }],
			...(typeof request.timeZone === "string" && request.timeZone ? { clientTimeZone: request.timeZone } : {})
		};
		try {
			// `prompt` dereferences its signal (`signal.throwIfAborted()`), so it
			// must always be a real AbortSignal. It is deliberately NOT tied to
			// the phone's HTTP request: a phone that drops off mid-send must
			// still get its prompt admitted.
			await controller.prompt(prompt, new AbortController().signal);
		} catch (error) {
			throw new Error(`发送失败：${reason(error)}`);
		}
		return { accepted: true };
	}

	/** Cancel the active turn of a Session without dropping its inbox. */
	cancel(sessionId) {
		const controller = this.requireController();
		try {
			controller.cancel({ sessionId: String(sessionId) });
		} catch (error) {
			throw new Error(`停止失败：${reason(error)}`);
		}
		return { accepted: true };
	}

	/**
	 * Follow one Session's log from `options.fromSeq` (or from the opening
	 * snapshot when omitted). Returns the host's async iterable untouched.
	 */
	follow(request, signal) {
		const controller = this.requireController();
		const follow = {
			address: { kind: "session", sessionId: String(request.sessionId) },
			assistantStream: true,
			maxMessages: typeof request.maxMessages === "number" ? request.maxMessages : 60
		};
		return controller.follow(follow, signal);
	}

	/** Whether the phone is allowed to start new sessions. */
	get allowsCreate() {
		return this.options.allowCreate !== false;
	}

	/** Whether the phone is allowed to cancel turns. */
	get allowsCancel() {
		return this.options.allowCancel !== false;
	}

	/**
	 * The working directory the agent runs in, so an upload lands somewhere the
	 * agent may actually read it (the fs sandbox fences reads to the workspace).
	 * @returns the absolute path, or undefined when it cannot be determined.
	 */
	async sessionCwd(sessionId) {
		const sessions = this.ctx.get("sessions");
		const live = sessions && typeof sessions.get === "function" ? sessions.get(sessionId) : undefined;
		const fromLive = live && live.header && typeof live.header.cwd === "string" ? live.header.cwd : undefined;
		if (fromLive) return fromLive;
		try {
			const found = (await this.listSessions()).find((entry) => entry.sessionId === sessionId);
			if (found && found.cwd) return found.cwd;
		} catch {
			/* fall through to the configured default */
		}
		return this.options.cwd || undefined;
	}

	/**
	 * Write one uploaded file into the session's working directory.
	 *
	 * The agent gets a normal file it can open with its own tools — no attachment
	 * plumbing, no size-dependent model support. When the working directory is
	 * unknown the file goes under `$DSH_HOME`, and the caller is told it is
	 * outside the workspace so the phone can warn.
	 *
	 * @param sessionId - session the phone is uploading into.
	 * @param rawName - the client-supplied file name (sanitized here).
	 * @param source - async iterable of `Buffer` chunks (the request body).
	 * @param maxBytes - hard cap; the write is aborted past it.
	 */
	async saveUpload(sessionId, rawName, source, maxBytes) {
		const name = safeFileName(rawName);
		const cwd = await this.sessionCwd(sessionId);
		const insideWorkspace = typeof cwd === "string" && cwd.length > 0;
		const root = insideWorkspace ? cwd : join(dshHome(), "phone-remote-uploads", String(sessionId));
		const directory = insideWorkspace ? join(root, UPLOAD_DIR) : root;

		let mkdirError;
		try {
			mkdirSync(directory, { recursive: true });
		} catch (error) {
			mkdirError = error;
		}
		if (mkdirError) throw new Error(`无法创建上传目录：${reason(mkdirError)}`);

		const file = join(directory, `${stamp()}-${name}`);
		const partial = `${file}.part`;
		let written = 0;
		try {
			const out = createWriteStream(partial);
			const failed = new Promise((_, reject) => out.on("error", reject));
			for await (const chunk of source) {
				written += chunk.length;
				if (written > maxBytes) {
					out.destroy();
					throw Object.assign(new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`), { code: "file-too-large" });
				}
				if (!out.write(chunk)) await Promise.race([new Promise((resolve) => out.once("drain", resolve)), failed]);
			}
			await Promise.race([new Promise((resolve) => out.end(resolve)), failed]);
			renameSync(partial, file);
		} catch (error) {
			try {
				unlinkSync(partial);
			} catch {
				/* the partial file may never have been created */
			}
			throw error;
		}

		const shown = insideWorkspace ? relative(root, file).split("\\").join("/") : file;
		return {
			name,
			// The path the agent should use (relative to its working directory when
			// the file landed inside it, absolute otherwise).
			path: insideWorkspace ? shown : file,
			absolute: file,
			bytes: written,
			insideWorkspace
		};
	}

	/**
	 * Resume (without prompting) the Session's Agent and install the configured
	 * approval policy. Best effort: a failure here must never block a prompt.
	 */
	async #installPolicy(sessionId) {
		const policy = this.options.approvalPolicy;
		if (policy !== "never" && policy !== "ask") return;
		const controller = this.controller;
		if (!controller || typeof controller.resolveAgent !== "function") return;
		try {
			const resolved = await controller.resolveAgent(sessionId);
			const agent = resolved && resolved.agent;
			if (!agent) return;
			const approval = this.ctx.get("approval");
			if (approval && typeof approval.setPolicy === "function") {
				// `ApprovalPolicy` is the plain string union 'ask' | 'never'.
				approval.setPolicy(agent, policy);
			}
		} catch (error) {
			this.log.warn(`[phone-remote] 无法设置会话授权策略：${reason(error)}`);
		}
	}
}

/** Best-effort title for one session summary. */
function titleOf(item) {
	const fromProjection = item?.projections?.values?.title;
	if (typeof fromProjection === "string" && fromProjection.trim()) return fromProjection.trim();
	if (typeof item?.title === "string" && item.title.trim()) return item.title.trim();
	if (typeof item?.cwd === "string" && item.cwd.trim()) return item.cwd.trim().split(/[\\/]/).filter(Boolean).pop() || item.cwd;
	return String(item?.sessionId ?? "session");
}
