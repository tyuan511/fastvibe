// SPDX-License-Identifier: MIT
// Human-readable GitHub text projection. Pure functions only: no transport, no clock,
// no randomness, so an operation's body stays byte-identical across replays.
import type { PiReviewArtifact } from "./pi-reviewer.ts";

/**
 * GitHub closes a linked Issue only when the pull request body carries one of its
 * documented closing keywords (`close/closes/closed`, `fix/fixes/fixed`,
 * `resolve/resolves/resolved`) directly before a `#N` reference. The event it then
 * emits is the positive external fact `github-native-operation.ts` relies on for
 * strict (no PATCH) Issue settlement, so a PR opened without such a reference can
 * never complete the loop.
 *
 * Matching deliberately follows GitHub rather than a stricter reading: the keyword
 * only needs a non-word boundary, so a sentence like "this will not close #1" also
 * closes #1 upstream. Rejecting it here would refuse a body GitHub does link.
 */
const CLOSING = /(?<![\p{L}\p{N}_])(?:close[sd]?|fix(?:es|ed|s)?|resolve[sd]?)\s*:?\s*#(\d+)/giu;

/** Issue numbers this body would close on merge. Order follows the first mention. */
export function closingIssueNumbers(body: string): number[] {
  const numbers: number[] = [];
  for (const match of body.matchAll(CLOSING)) {
    const number = Number(match[1]);
    if (Number.isSafeInteger(number) && number > 0 && !numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

export interface PullBodyInput {
  /** What changed and why. Written for a reviewer, not for the model. */
  summary: string;
  /** Issue this pull request must close when merged. Omit only for unlinked work. */
  issueNumber?: number;
}

/** The only supported way to build a linked pull-request body. */
export function renderPullBody(input: PullBodyInput): string {
  const summary = input.summary.trim();
  if (!summary) throw new Error("PR 正文不能为空");
  if (input.issueNumber === undefined) return summary;
  const number = input.issueNumber;
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("issueNumber 必须是正整数");
  if (closingIssueNumbers(summary).includes(number)) return summary;
  return `${summary}\n\nCloses #${number}`;
}

const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
const label = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" } as const;
const verdictTitle = {
  approve: "Approved",
  "request-changes": "Changes requested",
  comment: "Review notes",
} as const;

/** One code span that cannot be closed early by a backtick in model-provided text. */
function code(value: string): string {
  const ticks = "`".repeat(Math.max(1, ...Array.from(value.matchAll(/`+/g), match => match[0].length + 1)));
  // Padding is only needed when the content itself starts or ends with a backtick.
  const padded = value.startsWith("`") || value.endsWith("`");
  return padded ? `${ticks} ${value} ${ticks}` : `${ticks}${value}${ticks}`;
}

function location(finding: PiReviewArtifact["findings"][number]): string {
  return finding.line === undefined ? code(finding.path) : `${code(finding.path)}:${finding.line}`;
}

/**
 * Markdown review body. The artifact id, head and base stay in the footer so a reader
 * can tie the comment back to the durable review record without exposing raw JSON.
 */
export function renderReviewBody(artifact: PiReviewArtifact): string {
  const findings = [...artifact.findings].sort((a, b) => order[a.severity] - order[b.severity] || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
  const failing = artifact.checks.filter(check => check.status !== "passed");
  const lines: string[] = [`## ${verdictTitle[artifact.verdict]}`, "", artifact.summary.trim()];

  if (findings.length === 0) lines.push("", "No findings.");
  else {
    lines.push("", `### Findings (${findings.length})`, "");
    for (const finding of findings) lines.push(`- **${label[finding.severity]}** ${location(finding)} — ${finding.message.trim()}`);
  }

  if (artifact.checks.length > 0) {
    lines.push("", "### Checks", "", "| Check | Status | Evidence |", "| --- | --- | --- |");
    for (const check of artifact.checks) {
      lines.push(`| ${check.name.replaceAll("|", "\\|")} | ${check.status} | ${check.evidence.replaceAll("|", "\\|")} |`);
    }
  }

  const warnings: string[] = [];
  if (artifact.verdict === "approve" && failing.length > 0) warnings.push(`Verdict is approve but ${failing.map(check => check.name).join(", ")} did not pass.`);
  if (warnings.length > 0) lines.push("", ...warnings.map(warning => `> ${warning}`));

  lines.push("", "---", "", `Review artifact ${code(artifact.artifactId)} · head ${code(artifact.headSha.slice(0, 12))} · base ${code(artifact.baseSha.slice(0, 12))}`);
  return lines.join("\n");
}
