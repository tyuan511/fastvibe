import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamingHighlighter } from "../src/renderer/src/lib/syntax-highlighter.ts";

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, "")
    .replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

test("streamed code retains completed lines and recolors the unfinished token", async () => {
  const stream = new StreamingHighlighter("ts");
  const partial = await stream.highlight("cons");
  const keyword = await stream.highlight("const");
  assert.notEqual(partial, keyword);
  assert.match(keyword, /var\(--shiki-token-keyword\)/);

  const line = "const value = 42;\n";
  const first = await stream.highlight(line);
  const second = await stream.highlight(`${line}// next`);
  assert.equal(textOf(second), `${line}// next`);
  assert.ok(second.startsWith(first.replace("</code></pre>", "")));
  assert.match(second, /var\(--shiki-token-comment\)/);
});

test("every chunk is visible, including newlines, tabs, unicode and unfinished lines", async () => {
  const stream = new StreamingHighlighter("javascript");
  let code = "";
  for (const chunk of ["const ", "label = ", '"中文😀";', "\n", "\n", "\t", "/* open", "\n", "comment", " */", "\n"]) {
    code += chunk;
    assert.equal(textOf(await stream.highlight(code)), code);
  }
  assert.equal(textOf(await stream.highlight(code)), code, "repeated input does not duplicate tokens");
});

test("grammar state crosses chunks and completed lines", async () => {
  const stream = new StreamingHighlighter("ts");
  await stream.highlight("/* start\n");
  const html = await stream.highlight("/* start\ninside");
  assert.match(html, /style="color:var\(--shiki-token-comment\)">inside<\/span>/);
  const closed = await stream.highlight("/* start\ninside */\nconst x = 1");
  assert.match(closed, /style="color:var\(--shiki-token-keyword\)">const<\/span>/);
});

test("replacement, truncation and empty input reset the prior grammar state", async () => {
  const stream = new StreamingHighlighter("ts");
  await stream.highlight("/* open\ncomment");
  const replacement = await stream.highlight("const x = 1");
  assert.equal(textOf(replacement), "const x = 1");
  assert.match(replacement, /var\(--shiki-token-keyword\)/);
  assert.equal(textOf(await stream.highlight("const")), "const");
  assert.equal(textOf(await stream.highlight("")), "");
  assert.equal(textOf(await stream.highlight("let y = 2")), "let y = 2");
});

test("queued updates stay ordered while the grammar loads", async () => {
  const stream = new StreamingHighlighter("python");
  const codes = ["def", "def f():\n", "def f():\n    return 1", "x = 2"];
  const results = await Promise.all(codes.map((code) => stream.highlight(code)));
  assert.deepEqual(results.map(textOf), codes);
});

test("unknown languages and oversized snippets safely fall back to plain text", async () => {
  const code = '<script>alert("x")</script> & <img src=x onerror="bad()">';
  for (const language of [undefined, "not-a-language", "__proto__", "constructor"]) {
    const html = await new StreamingHighlighter(language).highlight(code);
    assert.equal(textOf(html), code);
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("<img"));
  }
  const stream = new StreamingHighlighter("html");
  const large = `<${"x".repeat(120_000)}>`;
  assert.equal(textOf(await stream.highlight(large)), large);
  assert.equal(textOf(await stream.highlight("<div>ok</div>")), "<div>ok</div>");
});

test("language aliases and themed colors survive the Shiki upgrade", async () => {
  const code = "const x = 1";
  assert.equal(await new StreamingHighlighter("TS").highlight(code), await new StreamingHighlighter("typescript").highlight(code));
  for (const [language, snippet] of [
    ["tsx", 'const el = <div title="hi" />'],
    ["vue", '<template><div>{{ text }}</div></template>'],
    ["bash", 'echo "$HOME"'],
    ["json", '{"key": true}'],
    ["css", ".foo { color: red; }"],
  ]) {
    const html = await new StreamingHighlighter(language).highlight(snippet);
    assert.equal(textOf(html), snippet);
    assert.match(html, /var\(--shiki-/);
  }
});
