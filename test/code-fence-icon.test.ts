/**
 * The fence-language → icon-name table behind a code block's header glyph.
 *
 * Both halves fail silently: a key that is not a grammar id never matches (a `py` fence
 * would draw nothing while `python` draws), and a value the vendored manifest does not
 * recognise resolves to the blank page — which reads as "this language has no icon" rather
 * than as a typo. So the table is walked against the manifest that actually ships.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { resolveFileIcon } from "../src/shared/file-icons.ts";
import type { FileIconMapping } from "../src/shared/types.ts";
import { CODE_FENCE_ICON_LANGUAGES, codeFenceIconName } from "../src/renderer/src/lib/code-fence-icon.ts";
import { resolveLanguage } from "../src/renderer/src/lib/syntax-highlighter.ts";

const ICONS_ROOT = join(import.meta.dirname, "..", "resources", "file-icons");
const manifest = JSON.parse(
  readFileSync(join(ICONS_ROOT, "manifest.json"), "utf8"),
) as FileIconMapping;

test("every table key is a canonical grammar id the highlighter knows", () => {
  for (const language of CODE_FENCE_ICON_LANGUAGES) {
    // `resolveLanguage` folds a fence word to a grammar id; a key it does not return for
    // itself is a spelling that will never be looked up (`py` and `python3` both fail here,
    // the first because it is an alias, the second because it is nothing). `plaintext` is
    // the one id here with no grammar to load — the highlighter's own fallback.
    assert.equal(
      resolveLanguage(language),
      language,
      `${language} is not a grammar id — key the table by the grammar, not the alias`,
    );
  }
});

test("every table value resolves to a glyph that ships", () => {
  for (const language of CODE_FENCE_ICON_LANGUAGES) {
    const name = codeFenceIconName(language);
    assert.ok(name, `${language} has no file name`);
    const icon = resolveFileIcon(manifest, name);
    assert.notEqual(icon, manifest.file, `${language} → ${name} resolves to the blank page`);
    assert.ok(
      existsSync(join(ICONS_ROOT, "icons", `${icon}.svg`)),
      `${language} → ${icon}.svg is not vendored`,
    );
  }
});

test("the spellings a model writes all fold to one glyph", () => {
  for (const word of ["py", "python", "Python", " python "]) {
    assert.equal(codeFenceIconName(word), "x.py", word);
  }
  for (const word of ["ts", "TypeScript", "typescript"]) {
    assert.equal(codeFenceIconName(word), "x.ts", word);
  }
  for (const word of ["sh", "bash", "zsh", "shell", "shellscript"]) {
    assert.equal(codeFenceIconName(word), "x.sh", word);
  }
  assert.equal(codeFenceIconName("golang"), "x.go");
  assert.equal(codeFenceIconName("dockerfile"), "Dockerfile");
  assert.equal(codeFenceIconName("yml"), "x.yaml");
  assert.equal(codeFenceIconName("md"), "x.md");
  assert.equal(codeFenceIconName("env"), "x.env");
  // The two words a ```diff / ```patch fence writes, and the empty text block's.
  assert.equal(codeFenceIconName("patch"), "x.diff");
  assert.equal(codeFenceIconName("text"), "x.txt");
});

test("an unknown or absent language draws no icon", () => {
  // A word that is not a grammar must not borrow a similar one's mark by prefix.
  assert.equal(codeFenceIconName("sqlite"), undefined);
  assert.equal(codeFenceIconName("hurl"), undefined);
  assert.equal(codeFenceIconName("typst"), undefined);
  assert.equal(codeFenceIconName(""), undefined);
  assert.equal(codeFenceIconName("   "), undefined);
  assert.equal(codeFenceIconName(undefined), undefined);
  // The prototype chain is not a language.
  assert.equal(codeFenceIconName("constructor"), undefined);
  assert.equal(codeFenceIconName("__proto__"), undefined);
  assert.equal(codeFenceIconName("toString"), undefined);
});
