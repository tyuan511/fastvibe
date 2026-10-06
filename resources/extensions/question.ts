import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * The `question` tool: the agent's way to stop and ask the user. It is always on,
 * for the main agent only (a delegated subagent loads no FastVibe extension but
 * `folder-consent`), so a clarifying question never has to be a guess.
 */
const QUESTION_TOOL = "question";
const T = (zh: string, en: string): string => (process.env.FASTVIBE_UI_LANGUAGE === "en" ? en : zh);
const otherAnswer = (): string => T("其他（自行输入）", "Other (type your own)");

/**
 * The structured payload the `question` tool returns. FastVibe's transcript renders
 * it as a Q&A card (`question-answers.tsx`), and the model sees the plain-text
 * summary in `content`.
 */
type QuestionAnswer = {
  question: string;
  header?: string;
  options: string[];
  answer: string | null;
  source: "option" | "custom" | "cancelled";
};
type QuestionDetails = { questions: QuestionAnswer[] };

/**
 * FastVibe-specific single-panel multi-question UI, feature-detected on `ctx.ui`.
 * Hosts that do not provide it (real pi/TUI) fall back to sequential select/input.
 */
type QuestionBridge = {
  questions?: (
    title: string,
    questions: Array<{
      question: string;
      header?: string;
      options?: string[];
      optionDetails?: Array<{ description?: string }>;
      allowOther?: boolean;
    }>,
    opts?: { timeout?: number },
  ) => Promise<Array<string | null> | undefined>;
};

/**
 * The `question` tool turns the agent's clarifying questions into the inline
 * panel: `ctx.ui.select` renders numbered options, `ctx.ui.input` a text field.
 * Questions are asked one at a time (one panel each) with a `问题 i/n` prefix, so
 * a single call can collect several answers even though the host has no
 * multi-question screen yet. 
 */
function registerQuestionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: QUESTION_TOOL,
    label: "Ask the user",
    description:
      "Ask the user one or more clarifying questions. Each question may offer options; allowOther (default true) also lets them type their own answer. Use when requirements are ambiguous.",
    promptSnippet: "Ask the user to clarify (multiple questions, options or free-form)",
    promptGuidelines: [
      "Use question when requirements are ambiguous and the user's decision changes what you build; put every clarifying question you need into one call instead of asking across turns. Do not ask what you can find out by reading the code.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String({ description: "The question to ask" }),
          header: Type.Optional(Type.String({ description: "Short label for the question (optional)" })),
          options: Type.Optional(
            Type.Array(
              Type.Object({
                label: Type.String({ description: "Option title" }),
                description: Type.Optional(Type.String({ description: "Extra detail for the option" })),
              }),
            ),
          ),
          allowOther: Type.Optional(Type.Boolean({ description: "Allow a free-form answer; default true" })),
        }),
        { description: "Questions to ask (one or more)" },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const items = params.questions ?? [];
      const collect = (text: string, answers: QuestionAnswer[]): { content: { type: "text"; text: string }[]; details: QuestionDetails } => ({
        content: [{ type: "text", text }],
        details: { questions: answers },
      });
      const unanswered = (): QuestionAnswer[] =>
        items.map((item) => ({
          question: item.question,
          header: item.header,
          options: (item.options ?? []).map((option) => option.label),
          answer: null,
          source: "cancelled",
        }));

      if (items.length === 0) {
        return { content: [{ type: "text", text: T("没有要问的问题。", "No questions to ask.") }], details: { questions: [] } as QuestionDetails };
      }
      if (!ctx.hasUI) return collect(T("无法提问：当前会话没有可用的交互界面。", "Cannot ask: this session has no interactive UI."), unanswered());

      // Single-panel multi-question UI when the host offers it (FastVibe).
      const bridge = (ctx.ui as unknown as QuestionBridge).questions;
      if (typeof bridge === "function") {
        const specs = items.map((item) => ({
          question: item.question,
          header: item.header,
          options: (item.options ?? []).map((option) => option.label),
          optionDetails: (item.options ?? []).map((option) => ({ description: option.description })),
          allowOther: item.allowOther ?? true,
        }));
        const result = await bridge(T("需要你的回答", "Your answer is needed"), specs);
        if (!result) return collect(formatAnswers(unanswered()), unanswered());
        const answers = items.map((item, i): QuestionAnswer => {
          const labels = (item.options ?? []).map((option) => option.label);
          const value = result[i];
          if (typeof value !== "string" || !value.trim()) {
            return { question: item.question, header: item.header, options: labels, answer: null, source: "cancelled" };
          }
          const answer = value.trim();
          return { question: item.question, header: item.header, options: labels, answer, source: labels.includes(answer) ? "option" : "custom" };
        });
        return collect(formatAnswers(answers), answers);
      }

      // Fallback: one panel per question.
      const answers: QuestionAnswer[] = [];
      let stopped = false;
      for (const [index, item] of items.entries()) {
        const labels = (item.options ?? []).map((option) => option.label);
        if (stopped) {
          answers.push({ question: item.question, header: item.header, options: labels, answer: null, source: "cancelled" });
          continue;
        }

        // A short progress prefix keeps multi-question runs legible in the panel.
        const title = `${items.length > 1 ? T(`问题 ${index + 1}/${items.length}：`, `Question ${index + 1}/${items.length}: `) : ""}${item.question}`;
        let answer: string | null = null;
        let source: QuestionAnswer["source"] = "cancelled";

        if (labels.length === 0) {
          const text = await ctx.ui.input(title);
          if (text !== undefined && text.trim()) {
            answer = text.trim();
            source = "custom";
          } else {
            stopped = true;
          }
        } else {
          const allowOther = item.allowOther ?? true;
          const choice = await ctx.ui.select(title, allowOther ? [...labels, otherAnswer()] : labels);
          if (choice === undefined) {
            stopped = true;
          } else if (choice === otherAnswer()) {
            const text = await ctx.ui.input(title);
            if (text !== undefined && text.trim()) {
              answer = text.trim();
              source = "custom";
            } else {
              stopped = true;
            }
          } else {
            answer = choice;
            source = "option";
          }
        }

        answers.push({ question: item.question, header: item.header, options: labels, answer, source });
      }

      return collect(formatAnswers(answers), answers);
    },
  });
}

/** Plain-text summary the model reads back. */
function formatAnswers(answers: QuestionAnswer[]): string {
  return answers
    .map((item, index) => `Q${index + 1}. ${item.question}\nA${index + 1}. ${item.answer ?? T("（用户未回答）", "(unanswered)")}`)
    .join("\n\n");
}

export default function question(pi: ExtensionAPI): void {
  registerQuestionTool(pi);
}
