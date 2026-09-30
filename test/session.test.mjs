/**
 * SessionBridge tests: the exact shape of what reaches the DSH services, the
 * approval-policy ordering, the upload writer, and the failure messages the
 * phone will see.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { SessionBridge, safeFileName } from "../lib/session.js";

// Never touch the real ~/.dsh while testing the upload fallback directory.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "phone-remote-session-"));

const silent = { info() {}, warn() {}, error() {} };

/** A fake host context exposing just the services the bridge reaches for. */
function fakeCtx(services) {
	return { get: (key) => services[key] };
}

/** A recording sessionController. */
function fakeController(overrides = {}) {
	const calls = [];
	return {
		calls,
		async list(request, signal) {
			calls.push(["list", request]);
			return {
				items: [
					{ sessionId: "s-live", running: true, blank: false, updatedAt: 30, cwd: "C:\\a", projections: { values: { title: "重构插件" } } },
					{ sessionId: "s-old", running: false, blank: false, updatedAt: 10, cwd: "C:\\b" },
					{ sessionId: "s-blank", running: false, blank: true, updatedAt: 40, cwd: "C:\\c" },
					{ sessionId: "s-sub", running: false, blank: false, updatedAt: 50, origin: "subagent", parentSessionId: "s-live" }
				]
			};
		},
		async create(request) {
			calls.push(["create", request]);
			return { sessionId: "s-new", agentPreset: "default" };
		},
		async resolveAgent(sessionId) {
			calls.push(["resolveAgent", sessionId]);
			return { agent: { id: sessionId } };
		},
		async prompt(request, signal) {
			calls.push(["prompt", request, signal]);
			return { accepted: true };
		},
		cancel(request) {
			calls.push(["cancel", request]);
			return { accepted: true };
		},
		follow(request, signal) {
			calls.push(["follow", request]);
			return (async function* () { yield { type: "snapshot" }; })();
		},
		...overrides
	};
}

describe("SessionBridge", () => {
	it("lists top-level sessions, running/blanks ordered sensibly", async () => {
		const bridge = new SessionBridge(fakeCtx({ sessionController: fakeController() }), {}, silent);
		const sessions = await bridge.listSessions();
		assert.deepEqual(sessions.map((s) => s.sessionId), ["s-live", "s-old", "s-blank"]);
		assert.equal(sessions[0].title, "重构插件");
		assert.equal(sessions[0].running, true);
		assert.equal(sessions[1].title, "b");
	});

	it("sends a plain-text prompt with a request id, a real signal and the phone's time zone", async () => {
		const controller = fakeController();
		const bridge = new SessionBridge(fakeCtx({ sessionController: controller }), {}, silent);
		await bridge.sendPrompt({ sessionId: "s-live", text: "跑一下测试", timeZone: "Asia/Shanghai" });
		const prompt = controller.calls.find((entry) => entry[0] === "prompt")[1];
		assert.equal(prompt.sessionId, "s-live");
		assert.equal(prompt.mode, "queue");
		assert.deepEqual(prompt.content, [{ type: "text", text: "跑一下测试" }]);
		assert.equal(prompt.clientTimeZone, "Asia/Shanghai");
		assert.match(prompt.requestId, /^mobile-/);
		// The host's `prompt(request, signal)` dereferences its signal, so it must
		// be a live AbortSignal and must not be pre-aborted.
		const signal = controller.calls.find((entry) => entry[0] === "prompt")[2];
		assert.equal(typeof signal?.aborted, "boolean");
		assert.equal(signal.aborted, false);
	});

	it("omits clientTimeZone when the phone does not send one", async () => {
		const controller = fakeController();
		const bridge = new SessionBridge(fakeCtx({ sessionController: controller }), {}, silent);
		await bridge.sendPrompt({ sessionId: "s-live", text: "hi", timeZone: "" });
		const prompt = controller.calls.find((entry) => entry[0] === "prompt")[1];
		assert.equal("clientTimeZone" in prompt, false);
	});

	it("installs the approval policy BEFORE the prompt, on the resumed agent", async () => {
		const order = [];
		const controller = fakeController({
			async resolveAgent(sessionId) {
				order.push("resolveAgent");
				return { agent: { id: sessionId } };
			},
			async prompt() {
				order.push("prompt");
				return { accepted: true };
			}
		});
		const approval = [];
		const ctx = fakeCtx({ sessionController: controller, approval: { setPolicy: (agent, policy) => approval.push([agent.id, policy]) } });
		const bridge = new SessionBridge(ctx, { approvalPolicy: "never" }, silent);
		await bridge.sendPrompt({ sessionId: "s-live", text: "hi" });
		assert.deepEqual(order, ["resolveAgent", "prompt"]);
		// `ApprovalPolicy` is the plain string union 'ask' | 'never'.
		assert.deepEqual(approval, [["s-live", "never"]]);
	});

	it("does not touch the policy when approvalPolicy is neither never nor ask", async () => {
		const controller = fakeController();
		const approval = [];
		const bridge = new SessionBridge(
			fakeCtx({ sessionController: controller, approval: { setPolicy: (...args) => approval.push(args) } }),
			{ approvalPolicy: "inherit" },
			silent
		);
		await bridge.sendPrompt({ sessionId: "s-live", text: "hi" });
		assert.equal(approval.length, 0);
		assert.equal(controller.calls.some((entry) => entry[0] === "resolveAgent"), false);
	});

	it("still prompts when the policy cannot be installed", async () => {
		const controller = fakeController({ async resolveAgent() { throw new Error("busy"); } });
		const warnings = [];
		const bridge = new SessionBridge(
			fakeCtx({ sessionController: controller, approval: { setPolicy() {} } }),
			{ approvalPolicy: "never" },
			{ info() {}, warn: (message) => warnings.push(message), error() {} }
		);
		await bridge.sendPrompt({ sessionId: "s-live", text: "hi" });
		assert.equal(controller.calls.some((entry) => entry[0] === "prompt"), true);
		assert.match(warnings.join("\n"), /无法设置会话授权策略/);
	});

	it("creates a session with the configured cwd and preset as defaults", async () => {
		const controller = fakeController();
		const bridge = new SessionBridge(fakeCtx({ sessionController: controller }), { cwd: "C:\\default", agentPreset: "default" }, silent);
		const created = await bridge.createSession({});
		assert.equal(created.sessionId, "s-new");
		const request = controller.calls.find((entry) => entry[0] === "create")[1];
		assert.deepEqual(request, { cwd: "C:\\default", agentPreset: "default" });

		await bridge.createSession({ cwd: "D:\\explicit" });
		const second = controller.calls.filter((entry) => entry[0] === "create")[1][1];
		assert.equal(second.cwd, "D:\\explicit");
	});

	it("follows the addressed session with assistant streaming on", async () => {
		const controller = fakeController();
		const bridge = new SessionBridge(fakeCtx({ sessionController: controller }), {}, silent);
		const frames = [];
		for await (const frame of bridge.follow({ sessionId: "s-live" }, new AbortController().signal)) frames.push(frame);
		const request = controller.calls.find((entry) => entry[0] === "follow")[1];
		assert.deepEqual(request.address, { kind: "session", sessionId: "s-live" });
		assert.equal(request.assistantStream, true);
		assert.equal(frames.length, 1);
	});

	it("explains a missing sessionController instead of throwing a TypeError", async () => {
		const bridge = new SessionBridge(fakeCtx({}), {}, silent);
		await assert.rejects(() => bridge.sendPrompt({ sessionId: "s", text: "x" }), /sessionController 服务不可用/);
		assert.throws(() => bridge.cancel("s"), /sessionController 服务不可用/);
	});

	it("rejects empty prompts and surfaces service failures verbatim", async () => {
		const bridge = new SessionBridge(fakeCtx({ sessionController: fakeController() }), {}, silent);
		await assert.rejects(() => bridge.sendPrompt({ sessionId: "s", text: "   " }), /内容为空/);
		await assert.rejects(() => bridge.sendPrompt({ text: "hi" }), /缺少会话 id/);

		const failing = new SessionBridge(
			fakeCtx({ sessionController: fakeController({ async prompt() { throw new Error("session/agent-busy"); } }) }),
			{},
			silent
		);
		await assert.rejects(() => failing.sendPrompt({ sessionId: "s", text: "hi" }), /发送失败：session\/agent-busy/);
	});

	it("honours allowCreate / allowCancel flags", () => {
		const off = new SessionBridge(fakeCtx({ sessionController: fakeController() }), { allowCreate: false, allowCancel: false }, silent);
		assert.equal(off.allowsCreate, false);
		assert.equal(off.allowsCancel, false);
		const on = new SessionBridge(fakeCtx({ sessionController: fakeController() }), {}, silent);
		assert.equal(on.allowsCreate, true);
		assert.equal(on.allowsCancel, true);
	});
});

describe("uploads", () => {
	/** A bridge whose one session lives in `cwd`. */
	function bridgeIn(cwd) {
		const controller = fakeController({
			async list() {
				return { items: cwd === undefined ? [] : [{ sessionId: "s-live", running: false, blank: false, updatedAt: 1, cwd }] };
			}
		});
		return new SessionBridge(fakeCtx({ sessionController: controller }), {}, silent);
	}

	it("sanitizes client-supplied file names", () => {
		assert.equal(safeFileName("report.pdf"), "report.pdf");
		assert.equal(safeFileName("../../etc/passwd"), "passwd");
		assert.equal(safeFileName("C:\\Users\\someone\\.ssh\\id_rsa"), "id_rsa");
		assert.equal(safeFileName("...hidden"), "hidden");
		assert.equal(safeFileName("a\u0000b<>:\"|?*.txt"), "a_b_______.txt");
		assert.equal(safeFileName(""), "file");
		assert.equal(safeFileName("   "), "file");
		assert.equal(safeFileName("x".repeat(300)).length, 120);
	});

	it("writes the upload into the session working directory", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "phone-cwd-"));
		const bridge = bridgeIn(cwd);
		const saved = await bridge.saveUpload("s-live", "笔记.txt", Readable.from([Buffer.from("hello "), Buffer.from("world")]), 1024);

		assert.equal(saved.name, "笔记.txt");
		assert.equal(saved.bytes, 11);
		assert.equal(saved.insideWorkspace, true);
		assert.match(saved.path, /^\.phone-uploads\/\d{8}-\d{6}-笔记\.txt$/, "the agent gets a workspace-relative path");
		assert.equal(readFileSync(saved.absolute, "utf8"), "hello world");
		assert.equal(existsSync(saved.absolute), true);
		assert.equal(saved.absolute.startsWith(cwd), true);
	});

	it("keeps two uploads with the same name apart", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "phone-cwd-"));
		const bridge = bridgeIn(cwd);
		const first = await bridge.saveUpload("s-live", "a.txt", Readable.from(["one"]), 1024);
		await new Promise((resolve) => setTimeout(resolve, 1100)); // different second in the stamp
		const second = await bridge.saveUpload("s-live", "a.txt", Readable.from(["two"]), 1024);
		assert.notEqual(first.absolute, second.absolute);
		assert.equal(readFileSync(first.absolute, "utf8"), "one");
		assert.equal(readFileSync(second.absolute, "utf8"), "two");
	});

	it("aborts an oversized upload and leaves no partial file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "phone-cwd-"));
		const bridge = bridgeIn(cwd);
		await assert.rejects(
			() => bridge.saveUpload("s-live", "big.bin", Readable.from([Buffer.alloc(4096)]), 1024),
			(error) => error.code === "file-too-large" && /1 MB|1024|上限/.test(error.message)
		);
		const leftovers = existsSync(join(cwd, ".phone-uploads")) ? readdirSync(join(cwd, ".phone-uploads")) : [];
		assert.equal(leftovers.some((name) => name.endsWith(".part")), false, "no partial file survives");
		assert.equal(leftovers.length, 0);
	});

	it("falls back to $DSH_HOME when the session has no working directory", async () => {
		const bridge = bridgeIn(undefined);
		const saved = await bridge.saveUpload("s-live", "a.txt", Readable.from(["x"]), 1024);
		assert.equal(saved.insideWorkspace, false);
		assert.equal(saved.path, saved.absolute, "outside the workspace the agent needs the absolute path");
		assert.match(saved.absolute, /phone-remote-uploads/);
		assert.equal(readFileSync(saved.absolute, "utf8"), "x");
	});

	it("respects the configured default directory when the session is cold", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "phone-cwd-"));
		const bridge = new SessionBridge(fakeCtx({ sessionController: fakeController({ async list() { return { items: [] }; } }) }), { cwd }, silent);
		const saved = await bridge.saveUpload("s-live", "b.txt", Readable.from(["y"]), 1024);
		assert.equal(saved.insideWorkspace, true);
		assert.equal(saved.absolute.startsWith(cwd), true);
	});
});
