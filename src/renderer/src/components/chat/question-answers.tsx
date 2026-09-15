import { type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import type { ToolCallBlock } from "@shared/types";
import { asRecord } from "@/lib/tool-presentation";

type QuestionAnswer = {
  question: string;
  answer: string | null;
  /** `custom` marks a free-form answer the user typed instead of picking an option. */
  source?: string;
};

function parse(value: unknown): QuestionAnswer[] {
  const list = asRecord(value)?.questions;
  if (!Array.isArray(list)) return [];
  const answers: QuestionAnswer[] = [];
  for (const item of list) {
    const entry = asRecord(item);
    const question = typeof entry?.question === "string" ? entry.question : "";
    if (!question) continue;
    answers.push({
      question,
      answer: typeof entry?.answer === "string" ? entry.answer : null,
      source: typeof entry?.source === "string" ? entry.source : undefined,
    });
  }
  return answers;
}

/**
 * Q&A card for the `question` tool. Prefers the result's structured `details`;
 * while the call is still running (no result yet) it falls back to the arguments
 * so the questions are visible before the user answers.
 */
export function QuestionAnswers({ tool, running }: { tool: ToolCallBlock; running: boolean }): JSX.Element | null {
  const answered = parse(tool.details);
  const questions = answered.length > 0 ? answered : parse(tool.args);
  if (questions.length === 0) return null;

  return (
    <div className="flex flex-col gap-2.5">
      {questions.map((item, index) => (
        <div key={index} className="flex flex-col gap-1">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 text-sm text-muted-foreground">{index + 1}.</span>
            <span className="text-sm leading-5 text-foreground">{item.question}</span>
          </div>
          {item.answer ? (
            <div className="flex items-center gap-1.5 pl-5">
              <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-3 shrink-0 text-success" />
              <span className="text-sm leading-5 text-foreground">{item.answer}</span>
              {item.source === "custom" ? <span className="text-sm text-muted-foreground">自行输入</span> : null}
            </div>
          ) : (
            <p className="pl-5 text-sm text-muted-foreground">{running ? "等待回答…" : "未回答"}</p>
          )}
        </div>
      ))}
    </div>
  );
}
