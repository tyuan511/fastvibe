import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MENU_COMMAND_IDS,
  chordToAccelerator,
  isMenuCommandId,
  sanitizeMenuBindings,
} from "../src/shared/menu-commands.ts";

/**
 * The macOS menu bar is drawn by Main, but the keys are decided in 设置 → 快捷键, which
 * lives in the renderer — and Electron does not tell you that an accelerator string is
 * nonsense. Measured against the shipped binary: `Menu.buildFromTemplate` accepts
 * `Cmd+Foo`, `Cmd++` and `Cmd+Nonexistent-Key` alike and echoes the string back, so an
 * unchecked conversion would put a shortcut in the menu that no keystroke ever matches.
 *
 * So the mapping is a whitelist, and these are the two shapes that must never reach a
 * menu: a key with no modifier (an `Escape` accelerator swallows every dialog and every
 * text field in the app), and a spelling the converter cannot vouch for.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("chordToAccelerator: the app's chord vocabulary becomes Electron accelerators", () => {
  assert.equal(chordToAccelerator("mod+k"), "Cmd+K");
  // The Mac's preferences key, which is the whole reason this menu exists.
  assert.equal(chordToAccelerator("mod+,"), "Cmd+,");
  assert.equal(chordToAccelerator("mod+shift+p"), "Cmd+Shift+P");
  assert.equal(chordToAccelerator("mod+["), "Cmd+[");
  assert.equal(chordToAccelerator("mod+]"), "Cmd+]");
  assert.equal(chordToAccelerator("ctrl+alt+delete"), "Ctrl+Alt+Delete");
  assert.equal(chordToAccelerator("mod+enter"), "Cmd+Enter");
  assert.equal(chordToAccelerator("mod+space"), "Cmd+Space");
  assert.equal(chordToAccelerator("mod+f5"), "Cmd+F5");
  assert.equal(chordToAccelerator("mod+1"), "Cmd+1");
  // Modifiers keep the order the chord was written in (Electron does not care), and a
  // doubled modifier is not written twice.
  assert.equal(chordToAccelerator("shift+mod+a"), "Shift+Cmd+A");
  assert.equal(chordToAccelerator("mod+shift+mod+a"), "Cmd+Shift+A");
});

test("chordToAccelerator: refuses what a menu must not take", () => {
  for (const chord of ["escape", "enter", "tab", "space", "f5", "k", "1"]) {
    assert.equal(chordToAccelerator(chord), null, `bare ${chord} must not be a menu key`);
  }
  for (const chord of ["", "   ", "mod+", "+", "mod", "mod+plus", "mod+*", "mod+\"", "mod+foo", null, undefined]) {
    assert.equal(chordToAccelerator(chord as string | null | undefined), null, `${chord} is not expressible`);
  }
});

test("sanitizeMenuBindings: only the commands the menu draws, only usable chords", () => {
  const clean = sanitizeMenuBindings({
    settings: "mod+,",
    newChat: "escape",
    commandPalette: null,
    prevChat: "mod+[",
    // A key the menu does not have, and a value that is not a chord at all.
    send: "mod+enter",
    openFolder: 42,
  });
  assert.deepEqual(clean, { settings: "mod+,", newChat: null, commandPalette: null, prevChat: "mod+[" });
  assert.deepEqual(sanitizeMenuBindings(undefined), {});
  assert.deepEqual(sanitizeMenuBindings("nope"), {});
  assert.deepEqual(sanitizeMenuBindings([]), {});
});

test("every menu command the keys belong to is a command the app knows", () => {
  // 关于 and 快捷键… are menu rows only — they navigate, so they carry no chord. Every
  // other id must exist in the renderer's catalog, or the menu would offer a command that
  // nothing can run.
  const catalog = readFileSync(path.join(HERE, "../src/renderer/src/lib/shortcuts.ts"), "utf8");
  const menuOnly = new Set(["about", "shortcutSettings"]);
  for (const id of MENU_COMMAND_IDS) {
    if (menuOnly.has(id)) continue;
    assert.match(catalog, new RegExp(`"${id}"`), `${id} is in the menu but not in SHORTCUT_CATALOG`);
  }
  assert.equal(new Set(MENU_COMMAND_IDS).size, MENU_COMMAND_IDS.length, "menu ids must be unique");
  assert.ok(isMenuCommandId("settings") && !isMenuCommandId("send"));
});
