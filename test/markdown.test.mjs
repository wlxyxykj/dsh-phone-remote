/**
 * Markdown renderer tests.
 *
 * The parser is pure (it returns plain node objects), so the browser and Node
 * run the exact same code — these tests cover what the phone actually renders.
 * The security cases matter most: the renderer must never emit anything that a
 * model could use to inject markup.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mdToNodes, inlineToNodes } from "../lib/markdown.js";

/** Flatten a node tree back to text (used to assert what a reader would see). */
function flatten(nodes) {
	return (nodes ?? []).map((node) => {
		if (node.tag === "text") return node.text;
		if (node.tag === "br") return "\n";
		if (node.tag === "hr") return "\n---\n";
		if (node.tag === "code" || node.tag === "pre") return node.text ?? node.code ?? "";
		if (node.tag === "a") return `${flatten(node.children)}<${node.href}>`;
		return flatten(node.children);
	}).join("");
}

/** The tags used by a tree, in order. */
function tags(nodes) {
	const out = [];
	for (const node of nodes ?? []) {
		out.push(node.tag);
		if (node.children) out.push(...tags(node.children));
	}
	return out;
}

describe("markdown", () => {
	it("renders **bold** instead of leaving the asterisks", () => {
		const nodes = mdToNodes("这是 **重点** 内容");
		assert.deepEqual(tags(nodes), ["p", "text", "strong", "text", "text"]);
		assert.equal(flatten(nodes), "这是 重点 内容");
		assert.equal(flatten(nodes).includes("*"), false);
	});

	it("handles the other inline forms", () => {
		assert.equal(flatten(mdToNodes("__粗__ 和 _斜_ 和 *斜*")).includes("_"), false);
		assert.deepEqual(tags(inlineToNodes("**a**")), ["strong", "text"]);
		assert.deepEqual(tags(inlineToNodes("~~删除~~")), ["del", "text"]);
		assert.deepEqual(tags(inlineToNodes("`code`")), ["code"]);
		assert.deepEqual(tags(inlineToNodes("*斜体*")), ["em", "text"]);
		assert.equal(flatten(inlineToNodes("`a*b*c`")), "a*b*c", "code spans win over emphasis");
	});

	it("nests emphasis inside emphasis", () => {
		const nodes = inlineToNodes("**粗体里的 `代码`**");
		assert.deepEqual(tags(nodes), ["strong", "text", "code"]);
		assert.equal(flatten(nodes), "粗体里的 代码");
	});

	it("parses headings, lists, quotes and rules", () => {
		const document = [
			"# 标题一",
			"",
			"## 标题二",
			"",
			"- 第一项",
			"- 第二项 **加粗**",
			"",
			"1. 有序一",
			"2. 有序二",
			"",
			"> 引用一行",
			"",
			"---"
		].join("\n");
		const nodes = mdToNodes(document);
		assert.deepEqual(nodes.map((node) => node.tag), ["h1", "h2", "ul", "ol", "blockquote", "hr"]);
		assert.equal(nodes[2].children.length, 2);
		assert.equal(nodes[3].children.length, 2);
		assert.equal(flatten(nodes[2].children), "第一项第二项 加粗");
	});

	it("keeps fenced code verbatim, including markdown characters", () => {
		const nodes = mdToNodes("前\n\n```js\nconst a = **not bold**;\n```\n\n后");
		const pre = nodes.find((node) => node.tag === "pre");
		assert.equal(pre.code, "const a = **not bold**;");
		assert.equal(nodes.filter((node) => node.tag === "strong").length, 0);
		assert.deepEqual(nodes.map((node) => node.tag), ["p", "pre", "p"]);
	});

	it("turns single newlines into line breaks inside a paragraph", () => {
		const nodes = mdToNodes("第一行\n第二行");
		assert.deepEqual(tags(nodes), ["p", "text", "br", "text"]);
		assert.equal(flatten(nodes), "第一行\n第二行");
	});

	it("links only http(s), mailto and site-relative targets", () => {
		const good = inlineToNodes("[文档](https://example.com/a)");
		assert.deepEqual(good.map((node) => node.tag), ["a"]);
		assert.equal(good[0].href, "https://example.com/a");
		assert.equal(inlineToNodes("[x](/m/help)")[0].href, "/m/help");
		assert.equal(inlineToNodes("[x](mailto:a@b.c)")[0].href, "mailto:a@b.c");
		// Anything a browser would treat as script stays literal text.
		for (const bad of ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "vbscript:x"]) {
			const nodes = inlineToNodes(`[x](${bad})`);
			assert.equal(nodes.some((node) => node.tag === "a"), false, `${bad} must not become a link`);
		}
	});

	it("never passes raw HTML through as markup", () => {
		const nodes = mdToNodes('<img src=x onerror="alert(1)"> <script>alert(2)</script>');
		assert.deepEqual(tags(nodes), ["p", "text"]);
		assert.equal(flatten(nodes), '<img src=x onerror="alert(1)"> <script>alert(2)</script>');
		// A reader sees the characters; the DOM builder only ever creates the
		// tags it knows, all of them filled via textContent.
		for (const node of nodes) assert.notEqual(node.tag, "img");
	});

	it("survives awkward input", () => {
		assert.deepEqual(mdToNodes("").length, 0);
		assert.deepEqual(mdToNodes(undefined).length, 0);
		assert.deepEqual(mdToNodes(null).length, 0);
		assert.deepEqual(tags(mdToNodes("```\nunclosed fence")), ["pre"]);
		assert.equal(flatten(mdToNodes("**unclosed bold")), "**unclosed bold");
		assert.equal(flatten(mdToNodes("普通 **中文** 混排 English **bold**")), "普通 中文 混排 English bold");
	});

	it("keeps a realistic answer readable", () => {
		const answer = [
			"已经改好了：**重启一次** 即可。",
			"",
			"改动点：",
			"1. 加粗不再显示多余星号",
			"2. 思考过程折叠成一行",
			"",
			"```bash",
			"tailscale ip -4",
			"```",
			"",
			"> 注意：换网络后无需再点允许。"
		].join("\n");
		const nodes = mdToNodes(answer);
		assert.deepEqual(nodes.map((node) => node.tag), ["p", "p", "ol", "pre", "blockquote"]);
		const text = flatten(nodes);
		assert.equal(text.includes("**"), false, "no stray bold markers");
		assert.equal(text.includes("`"), false, "no stray code markers");
		assert.equal(text.includes("tailscale ip -4"), true);
	});
});
