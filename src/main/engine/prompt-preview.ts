import { uiText } from "./ui-text.ts";
import { skillPromptText } from "../../shared/skill-invocation.ts";
import { extractPromptAttachments, stripPromptMetadata } from "../../shared/attachment-metadata.ts";

/**
 * Titles that mean "nothing named this chat yet". Both languages: the default is
 * written in whichever language the interface was in when the chat was created, and
 * a chat must not keep a placeholder title because the language changed since.
 */
const PLACEHOLDER_TITLES = new Set(["新会话", "新任务", "New chat", "New task"]);

const PREVIEW_CHARS = 80;
const TITLE_CHARS = 24;

/**
 * The head of `text` as a title, marked as a cut when the prompt had more to it.
 *
 * This is the title a chat wears until session-title names it — and, when that call
 * never landed, for good. A silent head-cut reads as a complete name: 「重构登录的中间件」
 * and 「重构登录的中间件还」 are indistinguishable, and the second is nonsense the reader
 * has no way to question. The ellipsis says the sentence continues in the chat, and the
 * last character gives way to it so the row stays within TITLE_CHARS.
 */
/**
 * What a prompt with no words at all is named by: the files it carries, else 图片.
 *
 * A screenshot with no caption is still a turn the person took, and the row cannot be
 * empty — an empty preview is how the catalog spots the project's blank draft, so naming
 * nothing hides the conversation the user just started.
 */
function attachmentLabel(text: string): string {
  const names = extractPromptAttachments(text).map((item) => item.name).filter(Boolean);
  if (names.length > 0) return names.slice(0, 2).join("、");
  return /\[Image: original \d+x\d+/.test(text) ? uiText("图片", "Image") : "";
}

function titleFrom(prompt: string): string {
  if (prompt.length <= TITLE_CHARS) return prompt;
  return `${prompt.slice(0, TITLE_CHARS - 1).trimEnd()}…`;
}

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
  // The engine's image note and a file list are model-facing metadata, not what the person
  // wrote, and both sit at the end of the text — a one-line prompt with a screenshot would
  // otherwise name the chat 「[Image: original 2160x1684, …」. A prompt that is nothing but
  // attachments still has to be named, or the row stays hidden: an empty preview is how the
  // catalog spots the project's blank draft.
  const words = stripPromptMetadata(skillPromptText(text)).trim();
  const preview = (words || attachmentLabel(text)).slice(0, PREVIEW_CHARS);
  const named = Boolean(current.titleManual) || Boolean(current.title && !PLACEHOLDER_TITLES.has(current.title));
  return {
    preview,
    title: (named && current.title ? current.title : titleFrom(preview)) || uiText("新会话", "New chat"),
  };
}
