import type { AdoptionPolicy } from "./dispatch.ts";
import type { DecideRequest, DecisionOutcome, JsonValue } from "./protocol.ts";

/**
 * 帮我批准 judged by the decision model (docs/decision-layer.md §7.11): one tool call in,
 * `allow` / `ask` out, or `null` when the model gave no answer worth acting on and the
 * sandbox's own pattern rules decide instead.
 *
 * The two answers are not symmetric, and the policy says so. `ask` is adopted at any
 * confidence: asking is what the rules would have done for anything suspicious, and a
 * needless prompt costs a click. `allow` needs `ALLOW_CONFIDENCE`, because it is the
 * answer that removes a prompt the rules wanted — the one a wrong answer turns into an
 * unrecoverable `rm`.
 *
 * Pure: the sandbox extension builds the call, Main sends it, this module owns what the
 * question says and what an outcome means.
 */

export const APPROVAL_BINDING = "sandbox.approval";
export const ALLOW_CONFIDENCE = 0.8;

/** What the sandbox hands over: never file contents, only what the dialog would show. */
export type ApprovalCall = {
  tool: string;
  /** The shell command, the path written, or a tool's serialised arguments. */
  subject: string;
  workspace: string;
  /** For a write: whether the target resolves inside the workspace. */
  insideWorkspace?: boolean;
  /** What the pattern rules matched, in English — possibly false alarms. */
  ruleFlags: string[];
};

export type ApprovalVerdict = "allow" | "ask";

/** Commands and argument dumps are cut here; the rest of a heredoc is not the risk. */
export const MAX_SUBJECT_CHARS = 4000;

const INSTRUCTIONS = {
  goal: "A coding agent running on the user's own computer is about to make this tool call. Decide whether it may run without asking the user first.",
  rules: [
    "rule_flags are what a pattern check matched. They can be false alarms (rm -rf of a build directory inside the workspace) and they can miss risks (find -delete, a Python one-liner that removes files, git push to delete a remote branch).",
    "Judge the effect, not the tool: the same command is routine on generated files and destructive on source files or on anything outside the workspace.",
    "If the effect cannot be determined from the call, choose ask.",
  ],
} satisfies { [key: string]: JsonValue };

const CRITERIA = {
  allow:
    "Run without asking. Routine and contained: reading, searching, building, testing, linting, formatting, running the project's own scripts, installing dependencies into the project, local git operations that keep work (status, diff, add, commit, stash, creating or switching branches), writing scratch files under a temp directory, and deleting generated files (build output, caches, node_modules) — effects that stay inside the workspace or are easy to undo.",
  ask:
    "Ask the user first. Deletes or overwrites data that may not be recoverable (source files, uncommitted changes, anything outside the workspace), rewrites git history or remote state (force push, deleting branches, reset --hard, publishing packages or releases), sends local files, secrets or credentials over the network, runs code downloaded from the internet, changes system settings, services, accounts or other applications, kills processes the agent did not start, or has an effect that cannot be determined.",
};

export function buildApprovalRequest(call: ApprovalCall): DecideRequest {
  const subject = call.subject.length > MAX_SUBJECT_CHARS ? `${call.subject.slice(0, MAX_SUBJECT_CHARS)}…` : call.subject;
  const state: { [key: string]: JsonValue } = {
    tool: call.tool,
    call: subject,
    workspace: call.workspace,
    rule_flags: call.ruleFlags,
  };
  if (call.insideWorkspace !== undefined) state.target_inside_workspace = call.insideWorkspace;
  return {
    version: 1,
    binding: APPROVAL_BINDING,
    state,
    questions: { verdict: { type: "choice", instructions: INSTRUCTIONS, criteria: CRITERIA } },
  };
}

export const approvalPolicy: AdoptionPolicy = {
  version: `${APPROVAL_BINDING}/allow>=${ALLOW_CONFIDENCE}`,
  accept: ({ answer, confidence }) =>
    answer.type === "choice" && (answer.choice === "ask" || (confidence !== undefined && confidence.value >= ALLOW_CONFIDENCE)),
};

/** `null` means "no verdict": the sandbox falls back to its pattern rules. */
export function approvalVerdict(outcome: DecisionOutcome): ApprovalVerdict | null {
  if (outcome.status !== "decided") return null;
  const answer = outcome.answers.verdict;
  if (answer?.type !== "choice") return null;
  return answer.choice === "allow" ? "allow" : answer.choice === "ask" ? "ask" : null;
}
