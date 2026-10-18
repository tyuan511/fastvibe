import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyShellLocale,
  availableLocales,
  localeIsSet,
  normalizeLocaleName,
  pickUtf8Locale,
  UTF8_LOCALES,
} from "../src/main/engine/shell-locale.ts";

/**
 * A GUI-launched Electron process has no locale, so every child runs in the C locale —
 * which is what makes the in-app terminal draw a typed 中文 as `<00ad><0096><0087>`.
 * These pin the rule that replaces it: only when nothing is set, only `LC_CTYPE`, and
 * only a locale this machine actually has.
 */

const MACOS_LOCALES = ["C", "POSIX", "C.UTF-8", "en_US", "en_US.UTF-8", "en_US.US-ASCII", "zh_CN.UTF-8", "zh_CN.GBK"];
/** glibc spells the same locale without the hyphen, and older ones have no `C.UTF-8`. */
const GLIBC_LOCALES = ["C", "POSIX", "C.utf8", "en_US.utf8"];
const NO_UTF8_LOCALES = ["C", "POSIX", "en_US", "en_US.ISO8859-1"];

test("normalizeLocaleName folds the platform spellings onto one key", () => {
  assert.equal(normalizeLocaleName("C.UTF-8"), normalizeLocaleName("C.utf8"));
  assert.equal(normalizeLocaleName("  en_US.UTF-8 "), "en_us.utf8");
  assert.notEqual(normalizeLocaleName("C.UTF-8"), normalizeLocaleName("C"));
});

test("pickUtf8Locale prefers the regionless C.UTF-8", () => {
  assert.equal(pickUtf8Locale(MACOS_LOCALES, "darwin"), "C.UTF-8");
  assert.equal(pickUtf8Locale(GLIBC_LOCALES, "linux"), "C.UTF-8");
  // A regional one is still UTF-8; only the region differs, and it changes nothing here.
  assert.equal(pickUtf8Locale(["C", "en_US.UTF-8"], "darwin"), "en_US.UTF-8");
});

test("pickUtf8Locale matches a glibc spelling without inventing one", () => {
  assert.equal(pickUtf8Locale(["C.utf8"], "linux"), "C.UTF-8");
});

test("pickUtf8Locale gives up rather than naming a locale the machine lacks", () => {
  // An invented name is worse than the C locale: every command would then print
  // `setlocale: LC_CTYPE: cannot change locale (…)`.
  assert.equal(pickUtf8Locale(NO_UTF8_LOCALES, "linux"), null);
  assert.equal(pickUtf8Locale([], "darwin"), null);
});

test("pickUtf8Locale answers macOS when the probe could not run", () => {
  // /usr/bin/locale is part of the OS, but a failed probe still has a safe answer here:
  // `en_US.UTF-8` ships with every macOS. Nowhere else is there one.
  assert.equal(pickUtf8Locale(null, "darwin"), "en_US.UTF-8");
  assert.equal(pickUtf8Locale(null, "linux"), null);
});

test("pickUtf8Locale leaves Windows alone", () => {
  // A Windows console has a code page, not a locale, and ConPTY hands over UTF-8.
  assert.equal(pickUtf8Locale(MACOS_LOCALES, "win32"), null);
});

test("every candidate it can pick is one of the documented preferences", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const picked = pickUtf8Locale(MACOS_LOCALES, platform);
    assert.ok(picked && UTF8_LOCALES.includes(picked));
  }
});

test("localeIsSet reads the three variables the C library consults", () => {
  assert.equal(localeIsSet({}), false);
  assert.equal(localeIsSet({ LANG: "", LC_ALL: "", LC_CTYPE: "" }), false);
  assert.equal(localeIsSet({ LANG: "   " }), false);
  assert.equal(localeIsSet({ LANG: "zh_CN.UTF-8" }), true);
  assert.equal(localeIsSet({ LC_CTYPE: "UTF-8" }), true);
  assert.equal(localeIsSet({ LC_ALL: "C" }), true);
});

test("applyShellLocale writes LC_CTYPE and nothing else", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/Users/someone", SHELL: "/bin/zsh", PATH: "/usr/bin" };
  assert.equal(applyShellLocale(env, "darwin", () => MACOS_LOCALES), "C.UTF-8");
  assert.equal(env.LC_CTYPE, "C.UTF-8");
  // `LANG` stays unset on purpose: it would also move LC_MESSAGES, LC_TIME and
  // LC_COLLATE, and a terminal that starts answering in another language or sorting
  // differently is a bigger surprise than the one being fixed.
  assert.equal(env.LANG, undefined);
  assert.equal(env.LC_ALL, undefined);
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LC_CTYPE", "PATH", "SHELL"]);
});

test("applyShellLocale never overrides a locale that is already there", () => {
  for (const env of [
    { LANG: "de_DE.UTF-8" },
    { LC_ALL: "C" }, // a deliberate choice, and the one that causes the garbage
    { LC_CTYPE: "UTF-8" },
  ]) {
    const before = { ...env };
    let probed = false;
    assert.equal(
      applyShellLocale(env, "darwin", () => {
        probed = true;
        return MACOS_LOCALES;
      }),
      null,
    );
    assert.deepEqual(env, before);
    // Nothing is spawned when the answer cannot change anything.
    assert.equal(probed, false);
  }
});

test("applyShellLocale writes nothing when no UTF-8 locale exists", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(applyShellLocale(env, "linux", () => NO_UTF8_LOCALES), null);
  assert.equal(env.LC_CTYPE, undefined);
});

test("applyShellLocale skips Windows and does not probe there", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(
    applyShellLocale(env, "win32", () => {
      throw new Error("must not probe");
    }),
    null,
  );
  assert.deepEqual(env, {});
});

test("availableLocales returns null instead of throwing when `locale` cannot be run", () => {
  // A probe that fails must not take startup with it, nor invent a locale.
  assert.equal(availableLocales({ PATH: "/nonexistent-directory" }), null);
});
