import assert from "node:assert/strict";
import { test } from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { toHtml } from "hast-util-to-html";
import { collapseBlankRuns, blankTakesRow, isBlankOutput } from "../src/renderer/src/lib/blank-output.ts";
import { splitMarkdownBlocks } from "../src/renderer/src/lib/markdown-blocks.ts";
import { REMARK_PLUGINS, REHYPE_PLUGINS } from "../src/renderer/src/lib/markdown-pipeline.ts";

/**
 * What a reply that says nothing costs the reader.
 *
 * The renderer is run here rather than eyeballed: `remark-parse` treats only ASCII space and
 * line terminators as blank, so the shapes that produce a wall of vertical nothing are the ones
 * it *cannot* see — `<br>`, NBSP, the ideographic space, zero-width characters. Those are the
 * inputs this test feeds it, and the assertion is about the HTML that comes out.
 */
function render(text: string): string {
  return String(
    unified()
      .use(remarkParse)
      .use(REMARK_PLUGINS)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(REHYPE_PLUGINS)
      .use(function () {
        this.compiler = (tree: unknown) => toHtml(tree as never) as never;
      })
      .processSync(text).value,
  );
}

const count = (html: string, needle: RegExp): number => (html.match(needle) ?? []).length;

test("plain newlines were never the problem — the parser already drops them", () => {
  // Pinned first, because it is the shape everyone guesses: a reply of forty blank lines
  // renders as nothing at all, so the gap in the transcript is not this.
  assert.equal(render("\n".repeat(40)), "");
  assert.equal(render("前文\n\n" + "\n".repeat(30) + "\n后文"), "<p>前文</p>\n<p>后文</p>");
});

test("what is only breaks and invisible space is blank", () => {
  assert.equal(isBlankOutput(""), true);
  assert.equal(isBlankOutput("  \n\t "), true);
  assert.equal(isBlankOutput("\u00a0\u00a0\u00a0"), true);
  assert.equal(isBlankOutput("\u3000"), true);
  // `String.prototype.trim` keeps these two, which is why blankness is not `trim().length`.
  assert.equal(isBlankOutput("\u200b"), true);
  assert.equal(isBlankOutput("\ufeff"), true);
  assert.equal(isBlankOutput("<br>\n<br/>"), true);
  assert.equal(isBlankOutput("&nbsp;&nbsp;"), true);
  // Things that are blank-looking in source and draw something on screen.
  assert.equal(isBlankOutput("---"), false);
  assert.equal(isBlankOutput("<hr>"), false);
  assert.equal(isBlankOutput("<img src=\"https://example.com/a.png\">"), false);
  assert.equal(isBlankOutput("一个字"), false);
});

test("a run of <br> is shortened, not deleted", () => {
  assert.equal(collapseBlankRuns("<br>".repeat(40)), "<br><br>");
  assert.equal(collapseBlankRuns("<br>\n<br />\n<br><br>"), "<br><br>");
  // One or two are what the model actually meant, and they survive untouched.
  assert.equal(collapseBlankRuns("a<br>b"), "a<br>b");
  assert.equal(collapseBlankRuns("a<br><br>b"), "a<br><br>b");
  // The collapsed run still ends at a break, so the paragraph after it is not swallowed.
  assert.equal(collapseBlankRuns("<br><br><br>\n\n后文"), "<br><br>\n\n后文");
});

test("lines of invisible space stop being a paragraph each", () => {
  const padded = ("\u3000\n\n").repeat(20);
  assert.equal(count(render(padded), /<p[ >]/g), 20);
  assert.equal(count(render(collapseBlankRuns(padded)), /<p[ >]/g), 0);

  // A long run on one line wraps into many blank lines; it becomes a single space.
  assert.equal(collapseBlankRuns(`前文\u00a0\u00a0\u00a0\u00a0\u00a0后文`), "前文 后文");
  // Two are punctuation someone meant, and stay.
  assert.equal(collapseBlankRuns("a\u00a0\u00a0b"), "a\u00a0\u00a0b");

  // Prose on either side of a collapsed run is still two paragraphs.
  const wrapped = `前文\n\n${"\u200b\n".repeat(9)}\n后文`;
  assert.match(render(collapseBlankRuns(wrapped)), /<p>前文<\/p>\n<p>后文<\/p>/);
});

test("one &nbsp; is a word's non-breaking space, not padding", () => {
  // A README badge row, or 「5&nbsp;GB」: the entity is the point, and it must survive.
  assert.equal(collapseBlankRuns("5&nbsp;GB × 4"), "5&nbsp;GB × 4");
  assert.equal(collapseBlankRuns("a&nbsp;&nbsp;b"), "a&nbsp;&nbsp;b");
  assert.equal(collapseBlankRuns("a&nbsp;&nbsp;&nbsp;&nbsp;b"), "a b");
});

test("a blank part takes no row once the run has moved on", () => {
  assert.equal(blankTakesRow("正文", false), true);
  assert.equal(blankTakesRow("<br><br><br>", false), false);
  // The live tail keeps its row: the caret on an empty bubble is the reader's proof of life.
  assert.equal(blankTakesRow("\n\n", true), true);
});

test("the pathological reply costs a bounded number of lines", () => {
  const reply = `服务端修改正在进行中。\n\n${"<br>\n".repeat(60)}\n\n表单、列表展示已经完成。`;
  const before = count(render(splitMarkdownBlocks(reply).join("\n")), /<br>/g);
  const after = count(render(collapseBlankRuns(reply)), /<br>/g);
  assert.ok(before > 50, `the unguarded reply renders ${before} breaks`);
  assert.equal(after, 2);
  // Both real paragraphs are still there, and still separate.
  const html = render(collapseBlankRuns(reply));
  assert.match(html, /<p>服务端修改正在进行中。<\/p>/);
  assert.match(html, /<p>表单、列表展示已经完成。<\/p>/);
});
