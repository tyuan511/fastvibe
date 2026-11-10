import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ReviewReport } from "../../shared/review.ts";
import type { ReviewSnapshot } from "../engine/review-snapshot.ts";
import { uiText } from "../engine/ui-text.ts";

const text = (maximum = 8000) => Type.String({ minLength: 1, maxLength: maximum });
const enumeration = <T extends string>(values: readonly T[]) => Type.Union(values.map((value) => Type.Literal(value)));
const location = Type.Object({
  path: text(4096), startLine: Type.Integer({ minimum: 1 }), endLine: Type.Integer({ minimum: 1 }),
  side: enumeration(["old", "new"] as const),
});
const reportSchema = Type.Object({
  version: Type.Literal(1), summary: text(),
  findings: Type.Array(Type.Object({
    title: text(500), severity: enumeration(["P0", "P1", "P2", "P3"] as const),
    confidence: enumeration(["high", "medium"] as const),
    category: enumeration(["correctness", "contract", "security", "performance", "ui", "tests"] as const),
    location, trigger: text(), impact: text(), evidence: Type.Array(text(4000), { minItems: 1, maxItems: 20 }), recommendation: text(),
  }), { maxItems: 200 }),
  coverage: Type.Object({
    reviewedPaths: Type.Array(text(4096), { maxItems: 1000 }),
    unreviewedPaths: Type.Array(Type.Object({ path: text(4096), reason: text(2000) }), { maxItems: 1000 }),
  }),
});

/** These tools are the entire tool surface of the single read-only reviewer. */
export function createReviewTools(snapshot: ReviewSnapshot): { factory: ExtensionFactory; getReport: () => ReviewReport | undefined } {
  let report: ReviewReport | undefined;
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
  const failed = (error: unknown) => ({ content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: { reviewError: true }, isError: true });
  const factory: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: "review_read_file", label: uiText("读取审查快照", "Read review snapshot"),
      description: "Read a repository-relative file from this immutable review snapshot. Use old for the base and new for the target. Defaults: new, offset 1, limit 200. At most 500 lines per call; follow truncated pages explicitly. Cannot read the live filesystem, symbolic links or paths outside the repository.",
      parameters: Type.Object({ path: text(4096), side: Type.Optional(enumeration(["old", "new"] as const)), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
      async execute(_id, params, signal) {
        report = undefined;
        try { signal?.throwIfAborted(); return result(await snapshot.readFile(params.path, params.side, params.offset, params.limit)); }
        catch (error) { return failed(error); }
      },
    });
    pi.registerTool({
      name: "review_search", label: uiText("搜索审查快照", "Search review snapshot"),
      description: "Search literal single-line text in the immutable target snapshot. Optional path is a repository-relative file or directory; omit to search the repository. Returns at most 100 hits with truncation and skipped-path indicators. Changed files use captured contents; unchanged files use the pinned Git commit.",
      parameters: Type.Object({ query: text(500), path: Type.Optional(text(4096)) }),
      async execute(_id, params, signal) {
        report = undefined;
        try { signal?.throwIfAborted(); return result(await snapshot.search(params.query, params.path)); }
        catch (error) { return failed(error); }
      },
    });
    pi.registerTool({
      name: "submit_review_result", label: uiText("提交审查报告", "Submit review report"),
      description: "Submit the final structured review report after inspecting evidence and self-reviewing every finding. List every changed path as reviewed or unreviewed with a reason. Findings require actual code evidence and valid line ranges on the specified side. Empty findings are valid. Host validation rejects invalid coverage/locations and generates stable IDs and source excerpts. Reading or searching after submission invalidates it: submit again as your final tool call.",
      parameters: reportSchema,
      async execute(_id, params, signal) {
        report = undefined;
        try {
          signal?.throwIfAborted();
          report = snapshot.validateReport(params);
          return result({ reviewRunId: snapshot.context.id, accepted: true, findings: report.findings.length, unreviewedPaths: report.coverage.unreviewedPaths, message: uiText("审查报告已接收。请结束审查；若继续检查，必须重新提交报告。", "Review report accepted. Finish the review; further inspection requires resubmitting the report.") });
        } catch (error) { return failed(error); }
      },
    });
  };
  return { factory, getReport: () => report };
}
