import { test } from "node:test";
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { toHtml } from "hast-util-to-html";
import { REMARK_PLUGINS, REHYPE_PLUGINS, REHYPE_PLUGINS_WITH_HEADING_IDS } from "../src/renderer/src/lib/markdown-pipeline.ts";
import { splitMarkdownBlocks } from "../src/renderer/src/lib/markdown-blocks.ts";

/**
 * A reply's markup, judged.
 *
 * `remark-parse`, `remark-rehype` and `hast-util-to-html` are here only to build the processor
 * react-markdown builds for itself (`allowDangerousHtml: true` is its own default) and to
 * serialise the result — everything that decides what renders comes from the app's plugin
 * lists, so this tests the pipeline the transcript actually runs rather than a copy of it.
 * Rendering React to a string would need the component tree, which needs i18n and the session
 * store, and `pnpm test` is bare node.
 *
 * `processSync` rather than `parse` + `run`: the source travels in the virtual file, and
 * `remarkStrictInlineMath` re-reads a formula from it to decide whether it was math at all.
 * Run the tree without the file and every `$…$` resolves to an empty string and vanishes —
 * which is exactly the wrong kind of green test.
 */
function render(text: string, plugins = REHYPE_PLUGINS): string {
  return String(
    unified()
      .use(remarkParse)
      .use(REMARK_PLUGINS)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(plugins)
      .use(function () {
        this.compiler = (tree: unknown) => toHtml(tree as never) as never;
      })
      .processSync(text).value,
  );
}

test("raw HTML in a reply becomes markup, not the characters of it", () => {
  const html = render("Press <kbd>Ctrl</kbd>+<kbd>C</kbd>, H<sub>2</sub>O.<br/>Done.");
  assert.match(html, /<p>Press <kbd>Ctrl<\/kbd>\+<kbd>C<\/kbd>, H<sub>2<\/sub>O\.<br>Done\.<\/p>/);
  // The failure this replaces: react-markdown hands `raw` over as text, so the reader saw
  // the tags themselves.
  assert.ok(!html.includes("&lt;kbd&gt;"), "the source of the tag must not be printed");
});

test("a details block keeps the markdown written under it", () => {
  const html = render("<details><summary>为什么</summary>\n\n因为 **这样**。\n\n</details>");
  assert.match(html, /<details><summary>为什么<\/summary>/);
  assert.match(html, /<summary>为什么<\/summary>\s*<p>因为 <strong>这样<\/strong>。<\/p>\s*<\/details>/);
});

test("a centred picture and a badge row render as written", () => {
  const html = render('<div align="center">\n\n![状态](https://example.com/badge.svg)\n\n</div>');
  assert.match(html, /<div align="center">/);
  assert.match(html, /<img src="https:\/\/example\.com\/badge\.svg" alt="状态"/);
});

test("what can only be a weapon is dropped, and so is its content", () => {
  const html = render([
    "<script>alert(1)</script>",
    "<style>body{display:none}</style>",
    '<iframe src="https://example.com"></iframe>',
    '<object data="x"></object><embed src="y">',
    '<form action="/s"><input name="q"></form>',
    '<link rel="stylesheet" href="https://example.com/e.css"><meta charset="utf-8">',
    '<svg onload="alert(2)"><text>drawn</text></svg>',
  ].join("\n\n"));
  for (const tag of ["script", "style", "iframe", "object", "embed", "form", "link", "meta", "svg"]) {
    assert.ok(!html.includes(`<${tag}`), `${tag} reached the page`);
  }
  // Their text does not survive as prose either: a stylesheet shown as a paragraph is the
  // failure the default `strip` list leaves in place for everything but `script`.
  assert.ok(!html.includes("alert("), "script text survived");
  assert.ok(!html.includes("body{display:none}"), "the stylesheet became a paragraph");
  assert.ok(!html.includes("drawn"), "the dropped drawing left its words behind");
  // A disabled checkbox is what the GitHub schema turns a text input into; a submittable
  // field in a reply would post to whoever wrote it.
  assert.match(html, /<input[^>]*disabled[^>]*type="checkbox">/);
});

test("an event handler and a scripted URL are inert", () => {
  const html = render('<img src="https://example.com/a.png" onerror="alert(1)"> [x](javascript:alert(2)) <a href="data:text/html,<script>alert(3)</script>">y</a>');
  assert.ok(!html.includes("onerror"), "an event handler attribute survived");
  assert.ok(!html.includes("alert("), "script text survived");
  assert.ok(!html.includes("javascript:"), "the javascript: protocol survived");
  assert.ok(!html.includes("data:text/html"), "a data: URL survived as a link");
  assert.match(html, /<img src="https:\/\/example\.com\/a\.png"/);
});

test("a reply cannot style itself over the interface", () => {
  const html = render('<div class="fixed inset-0 z-50 bg-background" style="position:fixed;inset:0">panel</div>');
  assert.ok(!html.includes("fixed"), `a utility class or style reached the page: ${html}`);
  assert.match(html, /panel<\/div>/);
});

test("an id a reply names cannot collide with one the app uses", () => {
  const html = render('<div id="thread" name="thread">x</div>');
  assert.match(html, /id="user-content-thread"/);
  assert.ok(!/ id="thread"/.test(html), "the bare id survived");
});

test("KaTeX still typesets — sanitising runs before it, so the math marker must survive", () => {
  const html = render("能量是 $E=mc^2$，在下面。");
  assert.match(html, /class="katex"/);
  assert.ok(!html.includes("language-math"), "the marker is replaced by the typeset form");
});

test("a shell variable is still prose, and a path link still arrives", () => {
  const html = render("`$HOME` 和 $PATH 不是公式，但 /src/main/index.ts 是路径。");
  assert.match(html, /\$HOME/);
  assert.match(html, /\$PATH/);
  // The sanitizer re-encodes a URL it lets through, and `markdownPath` decodes it again —
  // which is the contract worth pinning: the link survives the filter in some spelling.
  assert.match(html, /<a href="fvpath:/);
  assert.match(html, /\/src\/main\/index\.ts"|\/src\/main\/index\.ts/);
});

test("the URLs the app's own previews need survive the filter", () => {
  assert.match(render('<img src="file:///tmp/a.png">'), /src="file:\/\/\/tmp\/a\.png"/);
  assert.match(render('<img src="data:image/png;base64,AAAA">'), /src="data:image\/png;base64,AAAA"/);
  // Relative is what a reply writes for a file it just produced, and it is always allowed.
  assert.match(render("![图](out/report.html)"), /src="out\/report\.html"/);
});

test("a table with markup in its cells is what people actually write", () => {
  // The classic case: `<br>` and `<b>` inside a GFM cell, which no markdown syntax can say.
  const html = render("| 名称 | 说明 |\n| --- | --- |\n| `a.ts` | 第一行<br>**加粗** |\n");
  assert.match(html, /<table>/);
  assert.match(html, /第一行<br><strong>加粗<\/strong>/);
});

test("a comment is not content", () => {
  const html = render("before<!-- hidden -->after");
  assert.ok(!html.includes("hidden"), `the comment leaked: ${html}`);
});

test("the document view still gets its heading ids", () => {
  const html = render("# 标题\n\n正文。", REHYPE_PLUGINS_WITH_HEADING_IDS);
  assert.match(html, /<h1 id="标题">标题<\/h1>/);
});

/**
 * The two halves together, which is what `MarkdownView` actually does: a reply is cut into
 * blocks that are parsed and memoised on their own, and raw HTML that is still open at a blank
 * line must not be one of the places it cuts.
 */
test("a disclosure survives being cut into blocks", () => {
  const reply = "先说结论。\n\n<details><summary>为什么</summary>\n\n因为 **这样**。\n\n</details>\n\n完。";
  const blocks = splitMarkdownBlocks(reply);
  assert.equal(blocks.join("\n"), reply, "splitting loses nothing");
  const rendered = blocks.map((block) => render(block)).join("\n");
  assert.match(rendered, /<summary>为什么<\/summary>[\s\S]*?<p>因为 <strong>这样<\/strong>。<\/p>[\s\S]*?<\/details>/);
  // The seams around it still split, so a long answer keeps its per-block memoisation.
  assert.ok(blocks.length > 1, "the whole reply collapsed into one block");
});

test("a tag closed on the line it opened does not glue the rest of the answer", () => {
  const reply = "<b>粗</b> 开头。\n\n第二段。\n\n第三段。";
  assert.deepEqual(splitMarkdownBlocks(reply), ["<b>粗</b> 开头。\n", "第二段。\n", "第三段。"]);
});

test("an autolink and a comparison are not read as an open tag", () => {
  // `<https://…>` is a name followed by `:`, and `a < b` has no name at all — neither may
  // turn the remainder of the reply into one unparsable block.
  const reply = "见 <https://example.com>。\n\n当 a < b 且 b > c 时。\n\n结束。";
  assert.deepEqual(splitMarkdownBlocks(reply), ["见 <https://example.com>。\n", "当 a < b 且 b > c 时。\n", "结束。"]);
});
