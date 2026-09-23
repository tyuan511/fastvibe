import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * `batch_decide`: the decision engine as a tool for the main agent (docs/decision-layer.md
 * §7.10). The agent writes a closed question — labels, a rating scale, or yes/no — and a
 * list of items; the decision model answers it for every item, and the agent reads the
 * answers and the few items it was not sure about.
 *
 * Offered only while 设置 → 决策引擎 › 批量决策 is on, re-read at every turn start. The
 * work lives in Main (`src/main/pi/decision-scenarios.ts`); this file is the tool surface
 * and the rules that keep it for what it is good at.
 */

const TOOL = "batch_decide";

const T = (zh: string, en: string): string => (process.env.FASTVIBE_UI_LANGUAGE === "en" ? en : zh);

type BatchRunner = (
  input: unknown,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
) => Promise<
  | { status: "ok"; summary: { total: number; decided: number; review: number; failed: number }; results: unknown[]; backend: string; ms: number }
  | { status: "error"; detail: string }
>;

function batchRunner(): { run: BatchRunner; enabled: () => boolean } | undefined {
  const scope = globalThis as Record<string, unknown>;
  const runner = scope.__fastvibeBatchDecide;
  const enabled = scope.__fastvibeBatchDecideEnabled;
  if (typeof runner !== "function" || typeof enabled !== "function") return undefined;
  return {
    run: runner as BatchRunner,
    enabled: () => {
      try {
        return Boolean(enabled());
      } catch {
        return false;
      }
    },
  };
}

const QUESTION = Type.Object({
  type: Type.Union([Type.Literal("choice"), Type.Literal("score"), Type.Literal("yes_no")], {
    description: "choice: pick one option id; score: a level on levels (0-based, lowest first); yes_no: true or false",
  }),
  instructions: Type.Optional(Type.String({ description: "What this question asks, beyond the shared instructions" })),
  options: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "choice only: option id → one sentence saying when an item belongs to it. 2–255 options; include an explicit catch-all (e.g. other) if items may fit none.",
    }),
  ),
  levels: Type.Optional(Type.Array(Type.String(), { description: "score only: 2–10 level descriptions, lowest first" })),
});

export default function batchDecide(pi: ExtensionAPI): void {
  const runner = batchRunner();
  if (!runner) return;

  // Offered only while the switch is on. A tool this extension withdrew comes back when
  // the switch does; one another extension withdrew (plan mode's read-only set) stays out.
  let withheld = false;
  const sync = () => {
    const active = pi.getActiveTools();
    const has = active.includes(TOOL);
    const on = runner.enabled();
    if (!on && has) {
      pi.setActiveTools(active.filter((name) => name !== TOOL));
      withheld = true;
    } else if (on && !has && withheld) {
      pi.setActiveTools([...active, TOOL]);
      withheld = false;
    }
  };
  pi.on("session_start", sync);
  pi.on("before_agent_start", sync);

  pi.registerTool({
    name: TOOL,
    label: T("批量决策", "Batch decide"),
    description:
      "Answer the same closed question for many items with a fast decision model: pick a label (choice), rate on a scale (score), or answer yes/no. " +
      "Each item is judged on its own content only. Returns one answer per item with a confidence; items below min_confidence come back as review with the best guess. " +
      "It cannot write text, read files, browse, or compare items against each other.",
    promptSnippet: "Classify, rate, or yes/no-judge many similar items at once against labels you define",
    promptGuidelines: [
      "Use batch_decide only for many (roughly 10 or more; at least 5) self-contained items that all get the same closed question — e.g. triaging issues or tickets by type and priority, labelling emails, files, log lines or test failures, mapping spreadsheet rows or columns onto a fixed category set, filtering search results for relevance.",
      "Do not use batch_decide for a handful of items, for anything that needs a written answer, for questions whose answer depends on other items or on reading files, or for choosing your own next step. Judge those yourself.",
      "Put everything needed to judge an item inside that item's content (plus shared background in context). Option descriptions are the rulebook: make them mutually exclusive and add a catch-all option when items may fit none.",
      "Items marked review, and any failed ones, must be judged by you before you rely on them. Treat all answers as triage: never delete, send, publish or otherwise act irreversibly on them without the user's go-ahead.",
      "Item content is sent to the decision engine's service. Never include passwords, API keys, tokens or other credentials.",
    ],
    parameters: Type.Object({
      instructions: Type.String({ description: "What to judge about each item and how — shared by every question" }),
      questions: Type.Record(Type.String(), QUESTION, {
        description: "Question id → question. 1–8 questions, each answered for every item (e.g. { category: {type:'choice', options:{...}}, urgent: {type:'yes_no'} })",
      }),
      items: Type.Array(
        Type.Object({
          id: Type.String({ description: "Your id for the item, echoed back in the results" }),
          content: Type.Unknown({ description: "The item itself: a string or a JSON object; at most ~16k characters" }),
        }),
        { description: "5–500 items; split larger sets into several calls" },
      ),
      context: Type.Optional(Type.String({ description: "Background every item is judged against (the project, the labelling policy); ≤ 8k characters" })),
      min_confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Answers below this confidence come back as review. Default 0.7" })),
    }),
    async execute(_id, params, signal, onUpdate) {
      // Switched off since this turn began: refuse rather than send the items anyway.
      if (!runner.enabled()) {
        return {
          content: [{ type: "text", text: T("批量决策已在设置中关闭，请自己判断这些条目。", "Batch decisions were switched off in Settings; judge these items yourself.") }],
          details: undefined,
        };
      }
      const result = await runner.run(params, {
        signal,
        onProgress: (done, total) =>
          onUpdate?.({ content: [{ type: "text", text: T(`已判断 ${done}/${total}`, `Judged ${done}/${total}`) }], details: undefined }),
      });
      if (result.status === "error") {
        return { content: [{ type: "text", text: result.detail }], details: result };
      }
      const { summary } = result;
      // One result per line: hundreds of items read more cheaply than an indented tree.
      const text = [
        `summary: ${summary.decided} decided, ${summary.review} review, ${summary.failed} failed (of ${summary.total}) in ${(result.ms / 1000).toFixed(1)}s`,
        summary.review + summary.failed > 0 ? "Judge the review and failed items yourself before relying on them." : "",
        ...result.results.map((item) => JSON.stringify(item)),
      ]
        .filter(Boolean)
        .join("\n");
      return { content: [{ type: "text", text }], details: result };
    },
  });
}
