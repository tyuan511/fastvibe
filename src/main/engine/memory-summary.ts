import { createHash } from "node:crypto";

/** Keep the prompt bounded; this is a character budget, not a token estimate. */
export const SUMMARY_PROMPT_MAX_CHARS = 20_000;

type Section = { heading: string; body: string };

function sections(text: string, level: number): Section[] {
  const pattern = new RegExp(`^#{${level}} .+$`, "gm");
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) return [{ heading: "", body: text.trim() }];
  const result: Section[] = [];
  const prefix = text.slice(0, matches[0].index).trim();
  if (prefix) result.push({ heading: "", body: prefix });
  matches.forEach((match, index) => result.push({
    heading: match[0],
    body: text.slice(match.index! + match[0].length, matches[index + 1]?.index ?? text.length).trim(),
  }));
  return result;
}

/** Small sections give their unused share to the remaining sections. */
function budgets(lengths: number[], weights: number[], total: number): number[] {
  const allocated = lengths.map(() => 0);
  let remaining = lengths.map((_, index) => index);
  while (remaining.length && total > 0) {
    const weight = remaining.reduce((sum, index) => sum + weights[index], 0);
    const small = remaining.filter((index) => lengths[index] <= Math.floor(total * weights[index] / weight));
    if (small.length) {
      for (const index of small) { allocated[index] = lengths[index]; total -= lengths[index]; }
      remaining = remaining.filter((index) => !small.includes(index));
    } else {
      for (const index of remaining) allocated[index] = Math.floor(total * weights[index] / weight);
      break;
    }
  }
  return allocated;
}

/** Keep complete paragraphs/bullets, including their continuation lines and heading ancestry. */
function compact(text: string, budget: number, level = 3, routing = false): string {
  if (text.length <= budget) return text;
  if (budget <= 0) return "";
  const groups = level <= 6 ? sections(text, level) : [{ heading: "", body: text }];
  if (groups.some((group) => group.heading)) {
    const shares = budgets(groups.map((group) => group.heading.length + 2 + group.body.length), groups.map(() => 1), Math.max(0, budget - 2 * (groups.length - 1)));
    return groups.map((group, index) => {
      const body = compact(group.body, shares[index] - group.heading.length - 2, level + 1, routing);
      return body ? [group.heading, body].filter(Boolean).join("\n\n") : "";
    }).filter(Boolean).join("\n\n");
  }
  // A top-level bullet and all its indented desc/learnings lines are one unit.
  const blocks = text.split(/\n(?=[-*+] )|\n\s*\n(?=\S)/).map((block) => block.trim()).filter(Boolean);
  const kept: string[] = [];
  let used = 0;
  for (const block of blocks) {
    let selected = block;
    let cost = selected.length + (kept.length ? 2 : 0);
    if (used + cost > budget) {
      // Old summaries can contain a multi-kilobyte topic. Keep its complete title as a
      // routing pointer rather than silently losing that project's only entry.
      const title = block.split("\n", 1)[0];
      if (!routing || !/^[-*+] /.test(title)) continue;
      selected = `${title.replace(/:\s*$/, "")}\n  - Details: search MEMORY.md for this topic.`;
      cost = selected.length + (kept.length ? 2 : 0);
      if (used + cost > budget) continue;
    }
    kept.push(selected);
    used += cost;
  }
  return kept.join("\n\n");
}

export function summaryBudgetProblem(summary: string): string | undefined {
  const length = summary.trim().length;
  return length > SUMMARY_PROMPT_MAX_CHARS
    ? `memory_summary.md has ${length} characters; maximum is ${SUMMARY_PROMPT_MAX_CHARS}. Move details to MEMORY.md and keep the routing index within this budget.`
    : undefined;
}

/** Legacy oversized summaries stay usable until the next successful consolidation. */
export function boundedMemorySummary(summary: string, basePath: string): string {
  const text = summary.trim();
  if (text.length <= SUMMARY_PROMPT_MAX_CHARS) return text;
  // Include omitted changes in snapshot identity, without changing the stable read rules.
  const revision = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const notice = `[Memory summary abridged; revision ${revision}. Complete entries were omitted to fit the context budget. Search MEMORY.md for details; you may read the full summary at ${basePath}/memory_summary.md with offset/limit when needed.]`;
  const groups = sections(text, 2);
  const weights = groups.map(({ heading }) => /what.?s in memory/i.test(heading) ? 6 : /user preferences/i.test(heading) ? 2 : 1);
  const available = SUMMARY_PROMPT_MAX_CHARS - notice.length - 4 - 2 * (groups.length - 1);
  const shares = budgets(groups.map((group) => group.heading.length + 2 + group.body.length), weights, Math.max(0, available));
  const body = groups.map((group, index) => {
    const content = compact(group.body, shares[index] - group.heading.length - 2, 3, /what.?s in memory/i.test(group.heading));
    return content ? [group.heading, content].filter(Boolean).join("\n\n") : "";
  }).filter(Boolean).join("\n\n");
  return [body, notice].filter(Boolean).join("\n\n");
}
