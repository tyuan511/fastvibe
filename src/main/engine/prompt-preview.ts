import { uiText } from "./ui-text.ts";
import { skillPromptText } from "../../shared/skill-invocation.ts";

/**
 * Titles that mean "nothing named this chat yet". Both languages: the default is
 * written in whichever language the interface was in when the chat was created, and
 * a chat must not keep a placeholder title because the language changed since.
 */
const PLACEHOLDER_TITLES = new Set(["新会话", "新任务", "New chat", "New task"]);

/**
 * The title and preview a chat's first prompt gives it.
 *
 * One function for both ways a prompt reaches a conversation, because the two must be
 * indistinguishable in the sidebar: the renderer's `recordPrompt` (the user pressed
 * Send) and a prompt Main sends itself (an extension command that opens a chat, like
 * `/handoff`). A name the user set by hand always wins over the derived one, and the
 * session-title extension refines it afterwards — this is only the title the row has
 * until then, so a row is never nameless.
 */
export function promptPreview(
  current: { title?: string; titleManual?: boolean },
  text: string,
): { title: string; preview: string } {
  // A prompt that forced a skill reaches Main twice over: the renderer records the draft
  // as typed (`/skill:office …`), and a chat whose first turn Main fills itself reads the
  // transcript, where that command has already been expanded into the whole SKILL.md.
  // Folding it back to the command keeps both paths writing the same row, and keeps a
  // skill's instructions out of the chat's name.
  const prompt = skillPromptText(text);
  const preview = prompt.trim().slice(0, 80);
  const named = Boolean(current.titleManual) || Boolean(current.title && !PLACEHOLDER_TITLES.has(current.title));
  return {
    preview,
    title: named && current.title ? current.title : preview.slice(0, 24) || uiText("新会话", "New chat"),
  };
}
