import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Settings copy is read by a person, so most of it is one line.
 *
 * Everything is capped. The number is not a style rule so much as a tripwire: it is
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
      .filter(([, value]) => [...value].length > cap)
      .map(([key, value]) => `${key} (${[...value].length})`);
    assert.deepEqual(offenders, [], `${language} has descriptions over ${cap} characters`);
  }
});
