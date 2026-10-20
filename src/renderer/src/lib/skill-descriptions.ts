import type { SkillInfo } from "@shared/types";

/**
 * The skill names the engine can load, with their one-line descriptions.
 *
 * The transcript's badges read this instead of the message: `text` only carries the
 * skill's *name* (what the engine records is the `SKILL.md` path, not its frontmatter),
 * and a tooltip that said `/Users/…/skills/office/SKILL.md` where it could say 「读取、生成和
 * 修改 Word…」 would be the worse hint. The shell already lists the skills for the composer's
 * `/` palette, so that list is handed here once per fetch.
 *
 * A module-level cache rather than a store field, because a badge is drawn deep in a
 * memoised transcript row: threading the list down as props would rebuild those rows on
 * every re-list, and 设置 → 技能 refetches when the route closes. Same reason
 * `lib/file-icons.ts` caches its table.
 */
let descriptions = new Map<string, string>();

/** Replace the whole table. Called with the list the palette was built from. */
export function rememberSkillDescriptions(skills: SkillInfo[]): void {
  const next = new Map<string, string>();
  for (const skill of skills) {
    const description = skill.description.trim();
    if (skill.name && description) next.set(skill.name, description);
  }
  descriptions = next;
}

/** The skill's own description, or `undefined` for a skill this engine no longer lists. */
export function skillDescription(name: string): string | undefined {
  return descriptions.get(name);
}
