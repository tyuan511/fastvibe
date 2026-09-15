import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * FastVibe's built-in session title — names a new conversation from the first
 * user prompt via a short, fire-and-forget model call (`pi.setSessionName`).
 *
 * Already-named sessions (manual rename, `/name`, parallel runs, side chats)
 * are left alone. Failures keep the truncated-prompt fallback the host set.
 */
const MAX_TITLE = 24;
const SHORT_TITLE = 16;
const PROMPT_CHARS = 500;

const INSTRUCTIONS = [
  "You name chat sessions. Reply with a title only.",
  "Rules:",
  `- at most ${SHORT_TITLE} characters (CJK counts as 1)`,
  "- no quotes, trailing punctuation, or emoji",
  "- same language as the user",
  "- no leading labels like Title: or 标题：",
].join("\n");

function hasUserMessages(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user");
}

/** A slash command with no arguments is not worth naming from. */
function isBareCommand(text: string): boolean {
  return /^\/\S+$/.test(text);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trim();
}

function cleanTitle(raw: string): string {
  let text = raw.trim().split(/\r?\n/, 1)[0] ?? "";
  text = text.replace(/^["「『“']+|["」』”']+$/g, "").trim();
  text = text.replace(/^(title|标题)\s*[:：]\s*/i, "").trim();
  text = text.replace(/[\s.。!！?？,，;；:：]+$/g, "").trim();
  return clip(text, MAX_TITLE);
}

function promptText(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  const withoutCommand = text.replace(/^\/\S+\s+/, "").trim();
  return clip(withoutCommand || text, PROMPT_CHARS);
}

export default function sessionTitle(pi: ExtensionAPI): void {
  let attempted = false;

  const apply = (name: string): void => {
    const title = cleanTitle(name);
    if (!title) return;
    // A rename that landed while we were generating wins.
    if (pi.getSessionName()) return;
    pi.setSessionName(title);
  };

  const generate = async (prompt: string, ctx: ExtensionContext): Promise<void> => {
    const model = ctx.model;
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return;
    try {
      const response = await ctx.modelRegistry.complete(
        model,
        {
          messages: [
            {
              role: "user",
              content: `${INSTRUCTIONS}\n\n<message>\n${prompt}\n</message>`,
              timestamp: Date.now(),
            },
          ],
        },
        { maxTokens: 128, cacheRetention: "none", timeoutMs: 20_000 },
      );
      if (response.stopReason === "error") return;
      const text = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("");
      apply(text);
    } catch {
      // Keep the host's truncated-prompt title.
    }
  };

  pi.on("session_start", (_event, ctx) => {
    attempted = Boolean(pi.getSessionName()) || hasUserMessages(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (attempted || pi.getSessionName()) return;
    const prompt = promptText(event.prompt);
    if (!prompt || isBareCommand(event.prompt.trim())) return;
    attempted = true;
    // Short first messages already make a good title; skip the extra call.
    if (prompt.length <= SHORT_TITLE && !prompt.includes("\n")) {
      apply(prompt);
      return;
    }
    void generate(prompt, ctx);
  });
}
