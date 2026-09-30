/**
 * Dependency-free Markdown subset → a plain node tree.
 *
 * The tree is built with plain objects only (no DOM APIs), so the exact same
 * parser runs in the phone browser and under `node --test`. The browser half
 * turns the tree into real elements with `createElement`/`textContent`, which
 * makes raw HTML in a model answer inert — this is a renderer, not an HTML
 * injector.
 *
 * Supported: fenced code, inline code, **bold**, *italic*, __bold__, _italic_,
 * ~~strikethrough~~, [links](https://…), # headings, - / 1. lists, > quotes,
 * horizontal rules, hard line breaks.
 *
 * @typedef {object} MdNode
 * @property {string} tag - element name, or `text` for a text leaf.
 * @property {string} [text] - leaf payload (`text`, `code`, `a`).
 * @property {string} [href] - link target (`a`).
 * @property {string} [code] - raw fenced-code payload (`pre`).
 * @property {MdNode[]} [children] - nested nodes.
 */

/** One inline token: code, bold, strike, italic or a link. */
const INLINE = /(`+)([^`]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\n]+?)\*|_([^_\n]+?)_|\[([^\]]+)\]\(([^)\s]+)\)/;

/**
 * Parse the inline (in-paragraph) syntax of one line.
 * @param text - raw line content.
 * @returns the parsed nodes.
 */
export function inlineToNodes(text) {
	const nodes = [];
	let rest = String(text ?? "");
	while (rest.length > 0) {
		const match = INLINE.exec(rest);
		if (match === null) {
			nodes.push({ tag: "text", text: rest });
			break;
		}
		if (match.index > 0) nodes.push({ tag: "text", text: rest.slice(0, match.index) });
		const [full, , code, boldA, boldB, strike, italicA, italicB, linkText, linkHref] = match;
		if (code !== undefined) {
			nodes.push({ tag: "code", text: code });
		} else if (boldA !== undefined || boldB !== undefined) {
			nodes.push({ tag: "strong", children: inlineToNodes(boldA ?? boldB) });
		} else if (strike !== undefined) {
			nodes.push({ tag: "del", children: inlineToNodes(strike) });
		} else if (italicA !== undefined || italicB !== undefined) {
			nodes.push({ tag: "em", children: inlineToNodes(italicA ?? italicB) });
		} else if (linkText !== undefined) {
			const href = safeHref(linkHref);
			if (href === undefined) nodes.push({ tag: "text", text: full });
			else nodes.push({ tag: "a", href, children: inlineToNodes(linkText) });
		} else {
			nodes.push({ tag: "text", text: full });
		}
		rest = rest.slice(match.index + full.length);
	}
	return nodes;
}

/** Only `http(s)`, `mailto:` and site-relative targets become links. */
function safeHref(href) {
	if (typeof href !== "string") return undefined;
	const value = href.trim();
	if (value.length === 0 || value.length > 2000) return undefined;
	return /^(https?:\/\/|mailto:|\/)/i.test(value) ? value : undefined;
}

/** Whether a line starts a non-paragraph block. */
function startsBlock(line) {
	return /^\s*(```+|~~~+)/.test(line)
		|| /^#{1,6}\s+/.test(line)
		|| /^\s*[-*+]\s+/.test(line)
		|| /^\s*\d+[.)]\s+/.test(line)
		|| /^\s*>\s?/.test(line)
		|| isRule(line);
}

/** Whether a line is a horizontal rule. */
function isRule(line) {
	return /^\s*(?:\*\s*){3,}$/.test(line) || /^\s*(?:-\s*){3,}$/.test(line) || /^\s*(?:_\s*){3,}$/.test(line);
}

/**
 * Parse a whole Markdown document into block nodes.
 * @param source - Markdown text.
 * @returns block nodes in order.
 */
export function mdToNodes(source) {
	const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
	const nodes = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];

		// Fenced code block.
		const fence = /^\s*(```+|~~~+)\s*[\w+#.-]*\s*$/.exec(line);
		if (fence) {
			const marker = fence[1][0];
			const closing = new RegExp(`^\\s*\\${marker}{3,}\\s*$`);
			const body = [];
			index += 1;
			while (index < lines.length && !closing.test(lines[index])) {
				body.push(lines[index]);
				index += 1;
			}
			index += 1; // consume the closing fence (or run off the end)
			nodes.push({ tag: "pre", code: body.join("\n") });
			continue;
		}

		if (/^\s*$/.test(line)) {
			index += 1;
			continue;
		}

		const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (heading) {
			nodes.push({ tag: `h${heading[1].length}`, children: inlineToNodes(heading[2]) });
			index += 1;
			continue;
		}

		if (isRule(line)) {
			nodes.push({ tag: "hr" });
			index += 1;
			continue;
		}

		// Lists (single level, which is what chat answers actually use).
		const firstBullet = /^\s*[-*+]\s+(.*)$/.exec(line);
		const firstNumber = /^\s*\d+[.)]\s+(.*)$/.exec(line);
		if (firstBullet || firstNumber) {
			const ordered = firstNumber !== null;
			const items = [];
			while (index < lines.length) {
				const bullet = /^\s*[-*+]\s+(.*)$/.exec(lines[index]);
				const number = /^\s*\d+[.)]\s+(.*)$/.exec(lines[index]);
				if (ordered && number) items.push(number[1]);
				else if (!ordered && bullet) items.push(bullet[1]);
				else break;
				index += 1;
			}
			nodes.push({
				tag: ordered ? "ol" : "ul",
				children: items.map((item) => ({ tag: "li", children: inlineToNodes(item) }))
			});
			continue;
		}

		// Block quote (recursively parsed).
		if (/^\s*>\s?/.test(line)) {
			const quoted = [];
			while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
				quoted.push(lines[index].replace(/^\s*>\s?/, ""));
				index += 1;
			}
			nodes.push({ tag: "blockquote", children: mdToNodes(quoted.join("\n")) });
			continue;
		}

		// Paragraph: consecutive plain lines, hard-wrapped with <br>.
		const paragraph = [];
		while (index < lines.length && !/^\s*$/.test(lines[index]) && !startsBlock(lines[index])) {
			paragraph.push(lines[index]);
			index += 1;
		}
		const children = [];
		paragraph.forEach((textLine, position) => {
			if (position > 0) children.push({ tag: "br" });
			children.push(...inlineToNodes(textLine));
		});
		nodes.push({ tag: "p", children });
	}
	return nodes;
}
