import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Settings copy is read by a person, so most of it is one line.
 *
 * The pane has a second kind of string that has to stay long, and it is worth naming
 * because a well-meaning 「让描述更简洁」 pass can delete exactly the sentence somebody
 * needs: the frp walkthrough, and the DNS verdicts that say what to change at the
 * registrar. Both are *instructions for something the user is doing outside this app* —
 * there is nowhere else for them to be written down, and a shortened version is a user
 * who cannot finish the setup.
 *
 * Everything else is capped. The number is not a style rule so much as a tripwire: it is
 * well above any one-line description in the file, so passing it means a string has
 * grown into a paragraph, which is the thing that makes a settings row read like
 * documentation. The explanation lives in this repo (AGENTS.md) and in the code's own
 * comments; the pane only has to say what the switch does.
 *
 * Chinese is the shorter of the two for the same content — roughly three characters per
 * four English — so one number cannot mean the same thing in both languages. zh gets the
 * tight budget; en's is there to catch a paragraph, not to force parity.
 */
const CAP: Record<string, number> = { zh: 130, en: 150 };

/**
 * The strings that are *instructions* rather than descriptions, and stay as long as the
 * task is.
 *
 * `frpIntro` is the whole preparation for running frps; `frpDomainHelp` names the exact
 * DNS record to add. Both describe steps taken outside FastVibe, so there is nowhere else
 * for them to live and a shortened version is a user who cannot finish the setup.
 */
const INSTRUCTION_PREFIXES = ["remote.frpIntro", "remote.frpDomainHelp"];

const locales = ["zh", "en"] as const;

function flatten(node: unknown, path: string[] = []): Array<[string, string]> {
  if (node === null || typeof node !== "object") {
    return typeof node === "string" ? [[path.join("."), node]] : [];
  }
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    value !== null && typeof value === "object" ? flatten(value, [...path, key]) : [[[...path, key].join("."), String(value)]],
  );
}

function read(language: string): Map<string, string> {
  const file = new URL(`../src/renderer/src/locales/${language}/settings.json`, import.meta.url);
  return new Map(flatten(JSON.parse(readFileSync(file, "utf8"))));
}

test("the two languages cover the same settings keys", () => {
  const zh = read("zh");
  const en = read("en");
  /**
   * `_one` / `_other` are i18next's plural suffixes, and only the languages that inflect
   * need them: English counts 「1 day / 2 days」, Chinese does not. So the English side is
   * allowed to carry a form the Chinese side has no use for — and only that direction,
   * because a Chinese-only key is a key nothing can ever render. Anything beyond the
   * plural forms is drift in both directions.
   */
  const plural = (key: string): boolean => /_(one|other|zero|two|few|many)$/.test(key);
  for (const key of zh.keys()) assert.ok(en.has(key), `en is missing ${key}`);
  for (const key of en.keys()) {
    assert.ok(zh.has(key) || plural(key), `zh is missing ${key}`);
  }
});

test("no settings description has grown into a paragraph", () => {
  for (const language of locales) {
    const cap = CAP[language]!;
    const offenders = [...read(language)]
      .filter(([key]) => !INSTRUCTION_PREFIXES.includes(key))
      .filter(([, value]) => [...value].length > cap)
      .map(([key, value]) => `${key} (${[...value].length})`);
    assert.deepEqual(offenders, [], `${language} has descriptions over ${cap} characters`);
  }
});

test("the frp setup walkthrough is still there, at whatever length", () => {
  // The cap above must not be tightened onto this one: it is the only place the DNS and
  // firewall steps are written down, and `frpIntro` legitimately runs long.
  const zh = read("zh");
  const intro = zh.get("remote.frpIntro") ?? "";
  assert.ok(intro.length > CAP.zh!, "frpIntro is the multi-step setup explanation and should not be trimmed to one line");
  assert.ok((zh.get("remote.frpDomainHelp") ?? "").includes("A 记录"), "the DNS step has to name the record to add");
});
