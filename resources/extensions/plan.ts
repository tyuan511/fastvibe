import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * FastVibe's built-in plan mode — a deliberately small replacement for the
 * `@narumitw/pi-plan-mode` package. Toggling is the whole command surface:
 *
 *   /plan   turn plan mode on (read-only exploration + a plan), or off again
 *
 * While active the extension appends a planning instruction to the system prompt,
 * blocks file-mutating tools, and enables the `question` tool so the agent can
 * clarify ambiguous requirements before writing the plan. The renderer reads the
 * `plan-mode` status key to show the badge beside the permission control; that
 * badge clears the mode by dispatching `/plan` again.
 */
const STATUS_KEY = "plan-mode";
const QUESTION_TOOL = "question";
const OTHER_ANSWER = "其他（自行输入）";

const INSTRUCTIONS = [
  "## Plan mode",
  "You are in plan mode. Explore the code, ask clarifying questions, and produce a concrete, ordered plan.",
  "Do not modify files and do not run commands that change state; wait for approval before editing anything.",
  "Use the question tool to resolve ambiguity before writing the plan; batch related questions into one call (one question per entry).",
].join("\n");

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
 * multi-question screen yet. Registered lazily and only made active while plan
 * mode is on, so normal editing turns are unaffected.
 */
function registerQuestionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: QUESTION_TOOL,
    label: "询问用户",
    description:
      "向用户提出一个或多个澄清问题。每个问题可以给出候选选项；allowOther 为 true（默认）时用户也能自行输入。需求不明确、需要用户拍板时使用。",
    promptSnippet: "向用户提问以澄清需求（支持多个问题，选项或自由输入）",
    promptGuidelines: [
      "Use question when requirements are ambiguous and the user's decision changes the plan; put every clarifying question you need into one call instead of asking across turns.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String({ description: "要问用户的问题" }),
          header: Type.Optional(Type.String({ description: "该问题的简短标签（可选）" })),
          options: Type.Optional(
            Type.Array(
              Type.Object({
                label: Type.String({ description: "选项标题" }),
                description: Type.Optional(Type.String({ description: "选项的补充说明" })),
              }),
            ),
          ),
          allowOther: Type.Optional(Type.Boolean({ description: "是否允许用户自行输入答案，默认 true" })),
        }),
        { description: "要问的问题列表（一个或多个）" },
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
        return { content: [{ type: "text", text: "没有要问的问题。" }], details: { questions: [] } as QuestionDetails };
      }
      if (!ctx.hasUI) return collect("无法提问：当前会话没有可用的交互界面。", unanswered());

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
        const result = await bridge("需要你的回答", specs);
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
        const title = `${items.length > 1 ? `问题 ${index + 1}/${items.length}：` : ""}${item.question}`;
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
          const choice = await ctx.ui.select(title, allowOther ? [...labels, OTHER_ANSWER] : labels);
          if (choice === undefined) {
            stopped = true;
          } else if (choice === OTHER_ANSWER) {
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
    .map((item, index) => `Q${index + 1}. ${item.question}\nA${index + 1}. ${item.answer ?? "（用户未回答）"}`)
    .join("\n\n");
}

/** Add/remove `question` from the active set without touching other tools. */
function setQuestionActive(pi: ExtensionAPI, on: boolean): void {
  const active = pi.getActiveTools();
  const has = active.includes(QUESTION_TOOL);
  if (on === has) return;
  pi.setActiveTools(on ? [...active, QUESTION_TOOL] : active.filter((name) => name !== QUESTION_TOOL));
}

export default function planMode(pi: ExtensionAPI): void {
  let active = false;
  let questionRegistered = false;

  pi.registerCommand("plan", {
    description: "进入/退出计划模式（只读探索并制定计划）",
    handler: async (_args, ctx) => {
      active = !active;
      if (active) {
        if (!questionRegistered) {
          registerQuestionTool(pi);
          questionRegistered = true;
        }
        setQuestionActive(pi, true);
      } else {
        setQuestionActive(pi, false);
      }
      ctx.ui.setStatus(STATUS_KEY, active ? "active" : undefined);
    },
  });

  pi.on("before_agent_start", (event) => {
    if (!active) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${INSTRUCTIONS}` };
  });

  pi.on("tool_call", (event) => {
    if (!active) return;
    if (event.toolName === "edit" || event.toolName === "write") {
      return { block: true, reason: "计划模式已开启：不会修改文件，请先给出计划。" };
    }
  });
}
