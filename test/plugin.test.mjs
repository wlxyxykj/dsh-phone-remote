/**
 * End-to-end plugin tests: mount the real plugin entry point against a fake
 * host context (recording services) and drive the whole phone path over HTTP.
 *
 * `DSH_HOME` is redirected to a temp directory first so the tests can never
 * touch the real `~/.dsh/dsh-phone-remote.json`.
 */

import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-phone-remote-test-"));

const { apply, normalizeConfig, name, inspectMount } = await import("../lib/index.js");
const { describe, it } = await import("node:test");
const assert = (await import("node:assert/strict")).default;

const TOKEN = "test-token-abcdefghijkl";

/** A fake host context: `effect` runs immediately, services come from a bag. */
function fakeCtx(services) {
	const disposers = [];
	return {
		disposers,
		services,
		// Real cordis exposes injected services as context properties.
		tools: services.tools,
		get: (key) => services[key],
		on() {},
		effect(callback) {
			const disposer = callback();
			disposers.push(disposer);
			return disposer;
		}
	};
}

/** Recording stand-in for `ctx.sessionController`. */
function controller() {
	const calls = [];
	return {
		calls,
		async list() {
			return { items: [{ sessionId: "s-live", running: true, blank: false, updatedAt: 5, cwd: "C:\\work", projections: { values: { title: "在写的项目" } } }] };
		},
		async create(request) {
			calls.push(["create", request]);
			return { sessionId: "s-new" };
		},
		async resolveAgent(sessionId) {
			return { agent: { id: sessionId } };
		},
		async prompt(request) {
			calls.push(["prompt", request]);
			return { accepted: true };
		},
		cancel(request) {
			calls.push(["cancel", request]);
			return { accepted: true };
		},
		async *follow(request, signal) {
			calls.push(["follow", request]);
			yield { type: "snapshot", cursor: 1, records: [] };
			yield { type: "assistant-stream", frame: { type: "chunk", chunk: { type: "text-delta", text: "正在干活" } } };
			await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
		}
	};
}

/** Mount the plugin and return everything a test needs. */
async function mount(config = {}) {
	const session = controller();
	const policies = [];
	const tools = [];
	const ctx = fakeCtx({
		sessionController: session,
		approval: { setPolicy: (agent, policy) => policies.push([agent.id, policy]) },
		tools: { register: (definition) => { tools.push(definition); return () => {}; } }
	});
	// Real cordis disposes a failed plugin's effects; emulate that so a failing
	// assertion can never leave a listening server behind and hang the runner.
	try {
		await apply(ctx, { host: "127.0.0.1", port: 0, token: TOKEN, cwd: "C:\\work", ...config });
	} catch (error) {
		for (const disposer of ctx.disposers.reverse()) {
			if (typeof disposer === "function") await disposer();
		}
		throw error;
	}
	const handle = inspectMount();
	const base = `http://127.0.0.1:${handle.bound.port}`;
	return {
		ctx, handle, base, session, policies, tools,
		async dispose() {
			for (const disposer of ctx.disposers.reverse()) {
				if (typeof disposer === "function") await disposer();
			}
		}
	};
}

/** Authenticated fetch against the mounted plugin. */
function call(base, path, options = {}) {
	const headers = { "x-mobile-token": TOKEN, ...(options.headers ?? {}) };
	if (options.body !== undefined) headers["content-type"] = "application/json";
	return fetch(`${base}${path}`, {
		method: options.method ?? "GET",
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body)
	});
}

describe("dsh-phone-remote plugin", () => {
	it("exported name matches the loader row", () => {
		assert.equal(name, "dsh-phone-remote");
	});

	it("normalizes config with safe defaults", () => {
		const config = normalizeConfig({});
		assert.equal(config.enabled, true);
		assert.equal(config.host, "0.0.0.0");
		assert.equal(config.port, 8790);
		assert.equal(config.approvalPolicy, "never");
		assert.equal(config.allowCreate, true);
		assert.equal(config.exposePanel, true);
		assert.equal(normalizeConfig({ port: "abc" }).port, 8790);
		assert.equal(normalizeConfig({ port: -1 }).port, 8790);
		assert.equal(normalizeConfig({ approvalPolicy: "ask" }).approvalPolicy, "ask");
		assert.equal(normalizeConfig({ enabled: false }).enabled, false);
		assert.equal(normalizeConfig({ port: 0 }).port, 0);
		// allowFrom accepts an array or a comma-separated string; empty is the default.
		assert.deepEqual(normalizeConfig({}).allowFrom, []);
		assert.deepEqual(normalizeConfig({ allowFrom: ["1.2.3.4", " 5.6.7.8 "] }).allowFrom, ["1.2.3.4", "5.6.7.8"]);
		assert.deepEqual(normalizeConfig({ allowFrom: "1.2.3.4, 5.6.7.8," }).allowFrom, ["1.2.3.4", "5.6.7.8"]);
		assert.deepEqual(normalizeConfig({ allowFrom: "nonsense" }).allowFrom, ["nonsense"]);
	});

	it("persists a panel allowlist change to the state file", async () => {
		const mounted = await mount({ token: "test-token-abcdefghijkl" });
		try {
			const result = await (await fetch(`${mounted.base}/api/panel/access`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "allow", ip: "203.0.113.42" })
			})).json();
			assert.equal(result.ok, true);
			assert.equal(result.access.enabled, true);
			const state = JSON.parse(readFileSync(join(process.env.DSH_HOME, "dsh-phone-remote.json"), "utf8"));
			assert.equal(state.allowEnabled, true);
			assert.deepEqual(state.allowFrom, ["203.0.113.42"]);
			// The tool reports the mode, so an agent can answer "is it locked down?".
			const status = await mounted.tools[0].execute({ action: "status" });
			assert.match(status.text, /访问控制：仅白名单（1 条）/);
		} finally {
			await mounted.dispose();
		}
	});

	it("lets config.allowFrom own the list (panel edits are refused)", async () => {
		const mounted = await mount({ allowFrom: ["10.1.2.3/32"] });
		try {
			const panel = await (await fetch(`${mounted.base}/api/panel/state`)).json();
			assert.equal(panel.access.fromConfig, true);
			assert.deepEqual(panel.access.ips, ["10.1.2.3/32"]);
			const refused = await fetch(`${mounted.base}/api/panel/access`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "allow", ip: "10.9.9.9" })
			});
			assert.equal(refused.status, 400);
			assert.match((await refused.json()).error.message, /allowFrom/);
		} finally {
			await mounted.dispose();
		}
	});

	it("does nothing when disabled", async () => {
		const session = controller();
		const ctx = fakeCtx({ tools: { register() { throw new Error("should not register"); } } });
		const result = await apply(ctx, { enabled: false, port: 0, token: TOKEN });
		assert.equal(result, undefined);
		assert.equal(session.calls.length, 0);
	});

	it("returns nothing from apply (cordis validates a plugin body's value as an effect)", async () => {
		const ctx = fakeCtx({
			sessionController: controller(),
			approval: { setPolicy() {} },
			tools: { register: () => () => {} }
		});
		let result;
		try {
			result = await apply(ctx, { host: "127.0.0.1", port: 0, token: TOKEN });
			// A non-disposer, non-nullish resolved value is rejected by cordis
			// with "Invalid effect", so `apply` must resolve to undefined.
			assert.equal(result, undefined);
		} finally {
			for (const disposer of ctx.disposers.reverse()) {
				if (typeof disposer === "function") await disposer();
			}
		}
	});

	it("persists the token in DSH_HOME so the link survives restarts", async () => {
		const file = join(process.env.DSH_HOME, "dsh-phone-remote.json");
		const mounted = await mount();
		try {
			assert.equal(existsSync(file), true);
			assert.equal(JSON.parse(readFileSync(file, "utf8")).token, TOKEN);
		} finally {
			await mounted.dispose();
		}
		// A second mount without an explicit token reuses the persisted one.
		const second = await mount({ token: undefined });
		try {
			assert.equal(second.handle.config.token, "", "config keeps what the user wrote");
			const panel = await (await fetch(`${second.base}/api/panel/state`)).json();
			assert.equal(panel.token, TOKEN, "the link must survive a restart");
		} finally {
			await second.dispose();
		}
		// With nothing persisted, one is minted and written back.
		writeFileSync(file, "{}", "utf8");
		const third = await mount({ token: undefined });
		try {
			const panel = await (await fetch(`${third.base}/api/panel/state`)).json();
			assert.match(panel.token, /^[a-z2-9]{24}$/);
			assert.equal(JSON.parse(readFileSync(file, "utf8")).token, panel.token);
		} finally {
			await third.dispose();
		}
	});

	it("serves the panel with links and rendered sessions", async () => {
		const mounted = await mount();
		try {
			const panel = await (await fetch(`${mounted.base}/api/panel/state`)).json();
			assert.equal(panel.token, TOKEN);
			assert.equal(panel.host, "127.0.0.1");
			assert.ok(panel.urls.length >= 1, "expected at least the configured-host link");
			assert.match(panel.urls[0].url, /^http:\/\/127\.0\.0\.1:\d+\/m\?t=test-token-abcdefghijkl$/);
			assert.equal(panel.sessions.length, 1);
			assert.equal(panel.sessions[0].title, "在写的项目");
			assert.equal(panel.defaultCwd, "C:\\work");
			const html = await (await fetch(`${mounted.base}/`)).text();
			assert.match(html, /手机遥控/);
		} finally {
			await mounted.dispose();
		}
	});

	it("drives create → prompt → stream from the phone surface", async () => {
		const mounted = await mount();
		try {
			const created = await (await call(mounted.base, "/api/m/create", { method: "POST", body: { cwd: "D:\\proj" } })).json();
			assert.equal(created.sessionId, "s-new");
			assert.equal(mounted.session.calls.find((entry) => entry[0] === "create")[1].cwd, "D:\\proj");

			const prompted = await (await call(mounted.base, "/api/m/prompt", { method: "POST", body: { sessionId: "s-live", text: "继续" } })).json();
			assert.equal(prompted.accepted, true);
			// Both the freshly created session and the prompted one get the policy.
			assert.deepEqual(mounted.policies, [["s-new", "never"], ["s-live", "never"]]);

			const controller = new AbortController();
			const stream = await call(mounted.base, "/api/m/stream?session=s-live", { headers: { accept: "text/event-stream" } });
			stream.headers.forEach(() => {});
			const reader = stream.body.getReader();
			const decoder = new TextDecoder();
			let text = "";
			while (text.split("\n\n").length < 4) {
				const { value, done } = await reader.read();
				if (done) break;
				text += decoder.decode(value, { stream: true });
			}
			controller.abort();
			assert.match(text, /event: hello/);
			assert.match(text, /"type":"snapshot"/);
			assert.match(text, /正在干活/);
			assert.deepEqual(mounted.session.calls.find((entry) => entry[0] === "follow")[1].address, { kind: "session", sessionId: "s-live" });

			const cancelled = await (await call(mounted.base, "/api/m/cancel", { method: "POST", body: { sessionId: "s-live" } })).json();
			assert.equal(cancelled.accepted, true);
		} finally {
			await mounted.dispose();
		}
	});

	it("registers a registry-valid phone_remote tool and returns the link", async () => {
		const mounted = await mount();
		try {
			assert.deepEqual(mounted.tools.map((entry) => entry.name).sort(), ["phone_remote", "phone_send_file"]);
			const tool = mounted.tools.find((entry) => entry.name === "phone_remote");
			assert.equal(typeof tool.execute, "function");
			// Contract enforced by ctx.tools.register(): output + render + JSON Schema.
			assert.equal(typeof tool.output, "object");
			assert.equal(typeof tool.output.render, "function");
			assert.equal(tool.output.schema.type, "object");
			assert.deepEqual(Object.keys(tool.parameters.properties), ["action"]);
			assert.deepEqual(tool.parameters.properties.action.enum, ["link", "status"]);

			const link = await tool.execute({ action: "link" });
			assert.equal(link.text.includes(TOKEN), true, "the link must carry the token");
			assert.match(link.text, /手机遥控链接/);
			// `execute` returns the canonical value; `render` turns it into blocks.
			assert.deepEqual(tool.output.render({ action: "link" }, link), [{ type: "text", text: link.text }]);
			assert.deepEqual(tool.output.render({}, { text: "" }), [{ type: "text", text: "" }]);

			const status = await tool.execute({ action: "status" });
			assert.match(status.text, /手机遥控状态/);
			assert.match(status.text, /可接管会话：1 个/);
			const fallback = await tool.execute({});
			assert.match(fallback.text, /手机遥控链接/, "no action defaults to link");
		} finally {
			await mounted.dispose();
		}
	});

	it("lets the agent push a produced file to the phone", async () => {
		const mounted = await mount();
		const directory = mkdtempSync(join(tmpdir(), "phone-tool-"));
		try {
			const tool = mounted.tools.find((entry) => entry.name === "phone_send_file");
			assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["name", "note", "path"]);
			assert.deepEqual(tool.parameters.required, ["path"]);

			const file = join(directory, "报告.md");
			writeFileSync(file, "# 报告\n", "utf8");
			const result = await tool.execute({ path: file, note: "刚生成" }, { agent: { id: "s-live" } });
			assert.match(result.text, /已发送到手机：报告\.md/);
			assert.deepEqual(tool.output.render({}, result), [{ type: "text", text: result.text }]);

			const state = await (await fetch(`${mounted.base}/api/m/state`, { headers: { "x-mobile-token": TOKEN } })).json();
			const entry = state.deliverables.find((item) => item.name === "报告.md");
			assert.ok(entry, "the deliverable is registered");
			assert.equal(entry.bytes, Buffer.byteLength("# 报告\n"));
			assert.equal(entry.note, "刚生成");

			// A relative path resolves against the session's working directory
			// (that resolution itself is covered in test/session.test.mjs).
			await assert.rejects(() => tool.execute({ path: join(directory, "missing.txt") }, {}), /找不到文件/);
			await assert.rejects(() => tool.execute({ path: directory }, {}), /不是一个文件/);
			await assert.rejects(() => tool.execute({ path: "" }, {}), /path 不能为空/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
			await mounted.dispose();
		}
	});

	it("stops listening on dispose", async () => {
		const mounted = await mount();
		const base = mounted.base;
		assert.equal((await fetch(`${base}/api/panel/state`)).status, 200);
		await mounted.dispose();
		await assert.rejects(() => fetch(`${base}/api/panel/state`));
	});

	it("honours enabled:false actions and token rotation", async () => {
		const mounted = await mount({ allowCreate: false, allowCancel: false });
		try {
			assert.equal((await call(mounted.base, "/api/m/create", { method: "POST", body: {} })).status, 403);
			const rotated = await (await fetch(`${mounted.base}/api/panel/rotate`, { method: "POST" })).json();
			assert.match(rotated.token, /^[a-z2-9]{24}$/);
			assert.equal((await call(mounted.base, "/api/m/state")).status, 401, "old token must stop working");
			const fresh = await fetch(`${mounted.base}/api/m/state`, { headers: { "x-mobile-token": rotated.token } });
			assert.equal(fresh.status, 200);
			const state = JSON.parse(readFileSync(join(process.env.DSH_HOME, "dsh-phone-remote.json"), "utf8"));
			assert.equal(state.token, rotated.token, "rotation is persisted");
		} finally {
			await mounted.dispose();
		}
	});

	it("carries a pre-rename state file over to the new name", async () => {
		// Runs last: it rewrites the shared DSH_HOME. The old file name held the
		// token before the package was renamed, and losing it would force every
		// existing phone to re-scan.
		const legacy = join(process.env.DSH_HOME, "mobile-remote.json");
		const current = join(process.env.DSH_HOME, "dsh-phone-remote.json");
		writeFileSync(legacy, JSON.stringify({ token: "legacy-token-abcdefghij", allowEnabled: true, allowFrom: ["10.1.2.3"] }), "utf8");
		rmSync(current, { force: true });

		const mounted = await mount({ token: undefined });
		try {
			const panel = await (await fetch(`${mounted.base}/api/panel/state`)).json();
			assert.equal(panel.token, "legacy-token-abcdefghij", "the old token is reused");
			assert.equal(panel.access.enabled, true, "the old allowlist is reused");
			assert.deepEqual(panel.access.ips, ["10.1.2.3"]);
			assert.equal(existsSync(current), true, "state is written under the new name");
			assert.equal(JSON.parse(readFileSync(current, "utf8")).token, "legacy-token-abcdefghij");
		} finally {
			await mounted.dispose();
		}
	});
});
