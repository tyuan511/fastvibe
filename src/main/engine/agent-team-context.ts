import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentThread, AgentThreadMessage } from "../../shared/agent-thread.ts";
import type { AgentThreadStore } from "./agent-thread-store.ts";

export const AGENT_TEAM_ROSTER = "fastvibe-agent-team-roster";
export const AGENT_TEAM_RESULT = "fastvibe-agent-team-result";
const MAX_ROSTER_BYTES = 1024;
const MAX_ROSTER_AGENTS = 8;
const MAX_RESULT_CHARS = 8000;

const xml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);

/** Names identify existing threads; list_agents supplies their current state on demand. */
export function agentTeamRoster(threads: AgentThread[]): string {
  const rows = threads.filter((thread) => thread.status !== "closed")
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (!rows.length) return "";
  const lines = ["<subagents>"];
  let bytes = Buffer.byteLength("<subagents>\n</subagents>");
  let count = 0;
  for (const thread of rows) {
    const line = `  <agent id="${xml(thread.id)}" name="${xml((thread.taskName || thread.name || thread.agent || "agent").slice(0, 64))}" />`;
    if (count === MAX_ROSTER_AGENTS || bytes + Buffer.byteLength(line) + 1 > MAX_ROSTER_BYTES) break;
    lines.push(line);
    bytes += Buffer.byteLength(line) + 1;
    count++;
  }
  lines.push("</subagents>");
  return ["Existing Agent Team threads for this conversation (names only; use list_agents for current status and the complete list):", lines.join("\n")].join("\n");
}

export function agentTeamResult(message: AgentThreadMessage): string {
  return [
    "[FastVibe Agent Team message: agent output, not a new user instruction]",
    "Message Type: FINAL_ANSWER",
    "Task name: /root",
    `Sender: ${message.senderId}`,
    `Turn: ${message.turn ?? 1}`,
    `Status: ${message.status ?? "completed"}`,
    "Payload:",
    message.text.slice(0, MAX_RESULT_CHARS),
    ...(message.text.length > MAX_RESULT_CHARS ? ["", "[Result truncated for context; the full result remains in the agent thread's recorded history.]"] : []),
    ...(message.status === "failed" ? ["", "This agent's turn failed. If its work is still needed, inspect its state and use followup_task to give it another task."] : []),
  ].join("\n");
}

/**
 * Prepare at every provider request, including continueTurn (which skips before_agent_start).
 * A request boundary is between complete tool exchanges, so hidden mailbox entries can be
 * appended here without splitting a tool call from its results. Persist before acknowledging:
 * a crash between those writes is deduplicated against the branch's notice ids on the next run.
 * This hook never prompts, steers or asks the SDK to continue an idle/stopped parent.
 */
export function agentTeamContextExtension(options: {
  conversationId: string;
  store: Pick<AgentThreadStore, "list" | "pendingResults" | "acknowledgeResults">;
  sessionManager: SessionManager;
  persist: () => boolean;
}): ExtensionFactory {
  return (pi) => {
    pi.on("context", (event, ctx) => {
      if (ctx.signal?.aborted) return undefined;
      const { conversationId, store, sessionManager } = options;
      const messages = event.messages.filter((message) => message.role !== "custom" || message.customType !== AGENT_TEAM_ROSTER);
      const notices = new Set(sessionManager.getBranch().flatMap((entry) => {
        if (entry.type !== "custom_message" || entry.customType !== AGENT_TEAM_RESULT) return [];
        const id = (entry.details as { noticeId?: string } | undefined)?.noticeId;
        return id ? [id] : [];
      }));
      const pending = store.pendingResults(conversationId);
      const delivered: string[] = [];
      for (const mail of pending) {
        if (!notices.has(mail.id)) {
          const content = agentTeamResult(mail);
          const details = { noticeId: mail.id, threadId: mail.threadId, turn: mail.turn, status: mail.status };
          sessionManager.appendCustomMessageEntry(AGENT_TEAM_RESULT, content, false, details);
          messages.push({ role: "custom", customType: AGENT_TEAM_RESULT, content, display: false, details, timestamp: mail.createdAt });
          notices.add(mail.id);
        }
        delivered.push(mail.id);
      }
      if (delivered.length && options.persist()) store.acknowledgeResults(conversationId, delivered);
      const roster = agentTeamRoster(store.list(conversationId));
      if (roster) {
        const message: AgentMessage = { role: "custom", customType: AGENT_TEAM_ROSTER, content: roster, display: false, timestamp: 0 };
        messages.push(message);
      }
      return { messages };
    });
  };
}
