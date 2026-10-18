import { test } from "node:test";
import assert from "node:assert/strict";
import { codeLanguageOf } from "../src/main/engine/file-preview.ts";
import { resolveLanguage } from "../src/renderer/src/lib/syntax-highlighter.ts";

/**
 * Two maps decide what a file preview is coloured with: Main names the language from the
 * file, and the renderer turns that name into a grammar. Neither half fails loudly — an
 * extension Main forgets, or a name the renderer does not know, leaves the pane showing a
 * correct file in plain text with nothing on screen to say why. So the pair is pinned here
 * as one contract: every name Main can hand over must still reach a grammar.
 *
 * Main states only a language a reader would not guess from the extension (`ts` →
 * typescript, `Makefile` → make, a dotfile → its own name); everything else goes over as
 * the extension and is resolved here, which is what keeps the two maps from rotting.
 */
test("the language Main names for a file reaches a grammar", () => {
  const cases: [name: string, ext: string, language: string][] = [
    // Renamed by Main, because the extension is not a language name.
    ["app.ts", ".ts", "typescript"],
    ["thing.mts", ".mts", "typescript"],
    ["index.mjs", ".mjs", "javascript"],
    ["main.rs", ".rs", "rust"],
    ["legacy.pas", ".pas", "pascal"],
    ["header.h", ".h", "c"],
    ["book.tex", ".tex", "latex"],
    ["thing.kts", ".kts", "kotlin"],
    // Resolved from the extension itself.
    ["page.vue", ".vue", "vue"],
    ["app.svelte", ".svelte", "svelte"],
    ["game.gd", ".gd", "gdscript"],
    ["main.zig", ".zig", "zig"],
    ["build.hcl", ".hcl", "hcl"],
    ["api.hurl", ".hurl", "hurl"],
    ["notes.rst", ".rst", "rst"],
    ["data.jsonl", ".jsonl", "jsonl"],
    ["a.scss", ".scss", "scss"],
    ["model.astro", ".astro", "astro"],
    // No extension to read, so the name is the language.
    ["Makefile", "", "make"],
    ["GNUmakefile", "", "make"],
    ["Dockerfile", "", "docker"],
    ["CMakeLists.txt", ".txt", "cmake"],
    ["Gemfile", "", "ruby"],
    ["Jenkinsfile", "", "groovy"],
    [".env", "", "dotenv"],
    [".editorconfig", "", "ini"],
    [".bashrc", "", "shellscript"],
    [".service", "", "systemd"],
    [".gitattributes", "", "codeowners"],
    [".zshrc", "", "shellscript"],
  ];
  for (const [name, ext, language] of cases) {
    const label = codeLanguageOf(name, ext);
    assert.equal(resolveLanguage(label), language, `${name}: Main said "${label}", which reaches no grammar`);
  }
});

test("an unknown extension is handed over as-is and stays plain", () => {
  // A file type neither map knows: plain text is the honest answer, not a wrong grammar.
  assert.equal(codeLanguageOf("ship.moons", ".moons"), "moons");
  assert.equal(resolveLanguage(codeLanguageOf("ship.moons", ".moons")), undefined);
  assert.equal(resolveLanguage(codeLanguageOf("notes", "")), undefined);
});

test("the label Main prints is the renamed one, not the extension", () => {
  // This is the string the preview header shows, so it is pinned by value as well: `ts` on
  // screen reads `typescript`, and a whole-file name reads its language.
  assert.equal(codeLanguageOf("app.ts", ".ts"), "typescript");
  assert.equal(codeLanguageOf("index.mjs", ".mjs"), "javascript");
  assert.equal(codeLanguageOf("Makefile", ""), "make");
  assert.equal(codeLanguageOf("CMakeLists.txt", ".txt"), "cmake");
  assert.equal(codeLanguageOf(".editorconfig", ""), "editorconfig");
  assert.equal(codeLanguageOf("Justfile", ""), "just");
});

test("a file named after an Object property does not hand back a function", () => {
  // Both maps are object literals, and `path.extname("constructor")` is "" — so the bare name
  // is the lookup key. Inheriting `Object.prototype` there would put a function into an IPC
  // reply, which is worse than losing the colour.
  assert.equal(codeLanguageOf("constructor", ""), "constructor");
  assert.equal(codeLanguageOf("__proto__", ""), "__proto__");
  assert.equal(codeLanguageOf("toString", ""), "tostring");
  assert.equal(codeLanguageOf("app.ts", ".ts"), "typescript");
});
