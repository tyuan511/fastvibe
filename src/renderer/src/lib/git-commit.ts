import type { GitStatus } from "../../../shared/ipc.ts";

export type GitCommitAction = "commit" | "commit-push";
type Operations = {
  stageAll: () => Promise<GitStatus>;
  generateMessage: () => Promise<string>;
  commit: (message: string) => Promise<GitStatus>;
  push: () => Promise<GitStatus>;
};
export type GitCommitOutcome =
  | { ok: true; status: GitStatus; message: string }
  | { ok: false; phase: "stage" | "generate" | "commit" | "push"; status?: GitStatus; error: unknown };

/** Report partial success so a failed network follow-up never offers to repeat the commit. */
export async function performGitCommit(action: GitCommitAction, message: string, operations: Operations, onCommitted: (status: GitStatus) => void): Promise<GitCommitOutcome> {
  let phase: "stage" | "generate" | "commit" | "push" = "stage";
  let status: GitStatus | undefined;
  try {
    status = await operations.stageAll();
    message = message.trim();
    if (!message) {
      phase = "generate";
      message = (await operations.generateMessage()).trim();
    }
    phase = "commit";
    status = await operations.commit(message);
    onCommitted(status);
    if (action === "commit-push") {
      phase = "push";
      status = await operations.push();
    }
    return { ok: true, status, message };
  } catch (error) {
    return { ok: false, phase, status, error };
  }
}
