import type { GitCommitOptions, GitStatus } from "../../../shared/ipc.ts";

export type GitCommitAction = "commit" | "amend" | "commit-push" | "commit-sync";
type Operations = {
  commit: (message: string, options?: GitCommitOptions) => Promise<GitStatus>;
  pull: () => Promise<GitStatus>;
  push: () => Promise<GitStatus>;
};
export type GitCommitOutcome =
  | { ok: true; status: GitStatus }
  | { ok: false; phase: "commit" | "pull" | "push"; status?: GitStatus; error: unknown };

/** Report partial success so a failed network follow-up never offers to repeat the commit. */
export async function performGitCommit(action: GitCommitAction, message: string, operations: Operations, onCommitted: (status: GitStatus) => void): Promise<GitCommitOutcome> {
  let phase: "commit" | "pull" | "push" = "commit";
  let status: GitStatus | undefined;
  try {
    status = await operations.commit(message, action === "amend" ? { amend: true } : undefined);
    onCommitted(status);
    if (action === "commit-sync") {
      phase = "pull";
      status = await operations.pull();
    }
    if (action === "commit-push" || action === "commit-sync") {
      phase = "push";
      status = await operations.push();
    }
    return { ok: true, status };
  } catch (error) {
    return { ok: false, phase, status, error };
  }
}
