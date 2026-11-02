import { memo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { CornerDownLeftIcon, MessageQuestionIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { IS_MAC, isTouchOnly } from "@/lib/platform";
import type { BotAttention } from "@shared/bot";

export const BotQuestions = memo(function BotQuestions({ questions, onAnswer, limit }: {
  questions: BotAttention[];
  onAnswer: (attentionId: string, answer: string) => Promise<void>;
  limit?: number;
}): JSX.Element | null {
  const { t } = useTranslation("app");
  const pending = questions.filter((item) => item.status === "pending");
  if (!pending.length) return null;
  const shown = limit ? pending.slice(0, limit) : pending;
  return <div className="flex flex-col gap-2">{shown.map((question) => <Question key={question.id} question={question} onAnswer={onAnswer} />)}</div>;
});

function Question({ question, onAnswer }: { question: BotAttention; onAnswer: (id: string, answer: string) => Promise<void> }): JSX.Element {
  const { t } = useTranslation("app");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = () => {
    if (busy || !answer.trim()) return;
    setBusy(true); setError(null);
    void onAnswer(question.id, answer.trim()).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
  };
  return <form className="glass-rim relative flex flex-col gap-2 overflow-hidden rounded-2xl border border-border bg-card p-2.5 shadow-sm" onSubmit={(event) => { event.preventDefault(); send(); }}>
    <div className="flex items-start gap-2"><HugeiconsIcon strokeWidth={2} icon={MessageQuestionIcon} className="mt-0.5 size-3.5 shrink-0 text-warning" /><p className="min-w-0 flex-1 max-h-32 overflow-y-auto whitespace-pre-wrap wrap-anywhere text-sm font-medium leading-5">{question.question}</p></div>
    <Textarea value={answer} rows={1} onChange={(event) => setAnswer(event.target.value)} placeholder={t("viviBot.answerPlaceholder")} aria-label={t("viviBot.answerPlaceholder")} disabled={busy} className="field-sizing-content max-h-32 min-h-9 resize-none rounded-lg bg-muted/40 text-sm shadow-none" onKeyDown={(event) => { if (event.key !== "Enter" || event.nativeEvent.isComposing) return; const modified = IS_MAC ? event.metaKey : event.ctrlKey; if (modified || (!event.shiftKey && !isTouchOnly())) { event.preventDefault(); send(); } }} />
    {error ? <p role="alert" className="wrap-anywhere px-0.5 text-sm text-destructive">{error}</p> : null}
    <div className="flex items-center justify-between gap-3 px-0.5"><p className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground"><HugeiconsIcon strokeWidth={2} icon={CornerDownLeftIcon} className="size-3.5 shrink-0 text-foreground" /><span className="truncate">{t("viviBot.answerHint")}</span></p><Button type="submit" size="sm" disabled={busy || !answer.trim()}>{busy ? <Spinner /> : null}{t("viviBot.answer")}</Button></div>
  </form>;
}
