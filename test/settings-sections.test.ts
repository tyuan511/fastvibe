import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * The settings *index* is a list, but it is drawn as if it were a set: the nav maps every
 * item to a row, the router validates a route against it, and the command palette lists
 * it. Nothing about that shape complains when one id appears twice — which is exactly how
 * 「远程访问」 ended up in both `workspace` and `system` after a merge that kept a
 * conflicting move from each side, and the pane was offered twice in the sidebar.
 *
 * The module imports Hugeicons and i18n so it cannot be loaded in a plain `node --test`
 * process; parsing the source is the price of checking the real list rather than a copy.
 */

const source = readFileSync(
  new URL("../src/renderer/src/components/settings/settings-sections.tsx", import.meta.url),
  "utf8",
);

/** The nav table, as `{ group, ids }` in file order. */
function listedSections(): Array<{ group: string; ids: string[] }> {
  const table = source.slice(source.indexOf("export const SETTINGS_SECTIONS"));
  const groups: Array<{ group: string; ids: string[] }> = [];
  for (const match of table.matchAll(/group: "(\w+)",\s*items: \[([\s\S]*?)\],\s*\},/g)) {
    groups.push({ group: match[1]!, ids: [...match[2]!.matchAll(/id: "(\w+)"/g)].map((m) => m[1]!) });
  }
  return groups;
}

/** The `SectionId` union, which the nav must cover exactly. */
function declaredSectionIds(): string[] {
  const union = source.slice(source.indexOf("export type SectionId"), source.indexOf("export type SettingsGroupId"));
  return [...union.matchAll(/\| "(\w+)"/g)].map((m) => m[1]!);
}

test("the parsers found the real table, not an empty list", () => {
  const groups = listedSections();
  // A regex that silently matches nothing would make everything below vacuously pass.
  assert.ok(groups.length >= 5, `expected the settings groups, found ${groups.length}`);
  assert.ok(declaredSectionIds().length >= 15, "expected the full SectionId union");
});

test("no section is listed twice", () => {
  const seen = new Map<string, string>();
  for (const { group, ids } of listedSections()) {
    for (const id of ids) {
      const first = seen.get(id);
      assert.equal(first, undefined, `${id} is listed in both ${first} and ${group}`);
      seen.set(id, group);
    }
  }
});

test("the nav and the SectionId union describe the same set", () => {
  const listed = listedSections().flatMap((group) => group.ids);
  const declared = declaredSectionIds();
  for (const id of declared) assert.ok(listed.includes(id), `${id} is declared but not reachable in the nav`);
  for (const id of listed) assert.ok(declared.includes(id), `${id} is in the nav but not a valid SectionId`);
});

test("every section has a label in both languages", () => {
  const listed = listedSections().flatMap((group) => group.ids);
  for (const language of ["zh", "en"]) {
    const locale = JSON.parse(
      readFileSync(new URL(`../src/renderer/src/locales/${language}/settings.json`, import.meta.url), "utf8"),
    ) as { sections: Record<string, string> };
    for (const id of listed) {
      assert.ok(locale.sections[id], `${language} is missing a label for ${id}`);
    }
  }
});
