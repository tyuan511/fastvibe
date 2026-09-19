import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  CornerDownLeftIcon,
  MessageQuestionIcon,
  ShieldAlertIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-layout";
import type { PermissionRequest } from "@shared/types";

export type PermissionResponse = {
  id: string;
  confirmed?: boolean;
  value?: string;
  cancelled?: boolean;
  always?: boolean;
  /** Positional answers for a `questions` prompt; `null` marks a skipped question. */
  answers?: Array<string | null>;
  planAction?: "approve" | "revise" | "ignore";
};

type Respond = (payload: PermissionResponse) => void;

function confirmOptions(t: (key: string) => string): Array<{ label: string; description: string; response: Pick<PermissionResponse, "confirmed" | "always"> }> {
  return [
    { label: t("permission.approveOnce"), description: t("permission.approveOnceDesc"), response: { confirmed: true } },
    { label: t("permission.alwaysAllow"), description: t("permission.alwaysDesc"), response: { confirmed: true, always: true } },
    { label: t("permission.deny"), description: t("permission.denyDesc"), response: { confirmed: false } },
  ];
}

/** Borderless inline input used for free-form answers, mirroring zcode's custom-answer row. */
const INLINE_INPUT =
  "h-auto min-h-5 rounded-none border-transparent bg-transparent px-0 py-0 text-sm font-medium leading-5 shadow-none focus-visible:border-transparent focus-visible:ring-0 md:text-sm";

/**
 * Inline prompt panel for extension dialogs, occupying the composer's slot at the
 * bottom of the thread instead of opening a modal. It handles the three shapes the
 * agent asks with:
 *
 * - `confirm` — approve a tool permission (allow once / always / deny)
 * - `select`  — pick one of a list (numbered listbox)
 * - `input`   — type a free-form answer
 *
 * `editor` (a multi-line prefill) still uses the modal `PermissionDialog`.
 */
export function PermissionPanel({ request, onRespond }: { request: PermissionRequest; onRespond: Respond }): JSX.Element | null {
  switch (request.method) {
    case "confirm":
      return <ConfirmPanel request={request} onRespond={onRespond} />;
    case "select":
      return <SelectPanel request={request} onRespond={onRespond} />;
    case "input":
      return <InputPanel request={request} onRespond={onRespond} />;
    case "questions":
      return <QuestionsPanel request={request} onRespond={onRespond} />;
    case "plan_review":
      return <PlanReviewPanel request={request} onRespond={onRespond} />;
    default:
      return null;
  }
}


/** Shared card: warning tone for approvals, primary tone for questions. */
function PanelShell({
  tone,
  meta,
  title,
  message,
  aside,
  hint,
  actions,
  children,
}: {
  tone: "warning" | "primary";
  /** Small label above the title, e.g. a question's header. */
  meta?: string;
  title: string;
  message?: string;
  /** Controls aligned to the top-right of the header, e.g. the paging arrows. */
  aside?: ReactNode;
  hint: string;
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const Icon = tone === "warning" ? ShieldAlertIcon : MessageQuestionIcon;
  return (
    <div className="@container/composer mx-auto w-full max-w-3xl px-6 pb-5">
      <div className="flex w-full flex-col gap-2 overflow-hidden rounded-2xl border border-border bg-popover p-2.5 shadow-sm">
        <div className="flex items-start gap-2">
          <HugeiconsIcon
            strokeWidth={2}
            icon={Icon}
            className={cn("mt-0.5 size-3.5 shrink-0", tone === "warning" ? "text-warning" : "text-primary")}
          />
          <div className="min-w-0 flex-1">
            {meta ? <p className="mb-0.5 truncate text-sm font-medium text-muted-foreground">{meta}</p> : null}
            <p className="whitespace-pre-wrap break-words text-sm font-medium leading-4.5 text-foreground">{title}</p>
            {message ? (
              <p className="mt-0.5 max-h-44 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-4.5 text-muted-foreground">
                {/* Collapse blank lines so a multi-paragraph plugin message stays dense. */}
                {message.replace(/\n{2,}/g, "\n").trim()}
              </p>
            ) : null}
          </div>
          {aside ? <div className="flex shrink-0 items-center gap-0.5">{aside}</div> : null}
        </div>
        {children}
        <div className="flex items-center justify-between gap-3 px-0.5">
          <p className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <HugeiconsIcon strokeWidth={2} icon={CornerDownLeftIcon} className="size-3.5 shrink-0 text-foreground" />
            <span className="truncate">{hint}</span>
          </p>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      </div>
    </div>
  );
}

function OptionRow({
  index,
  label,
  description,
  selected,
  onSelect,
  onHover,
}: {
  index: number;
  label: string;
  description?: string;
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onMouseEnter={onHover}
      onFocus={onHover}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors",
        selected ? "bg-accent" : "hover:bg-accent",
      )}
    >
      <span className={cn("w-4 shrink-0 self-center text-sm font-medium", selected ? "text-foreground" : "text-muted-foreground")}>
        {index + 1}.
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-medium leading-5 text-foreground">{label}</span>
        {description ? <span className="text-sm font-normal leading-4 text-muted-foreground">{description}</span> : null}
      </span>
    </button>
  );
}

/** An option-shaped row whose content is a borderless input (the custom answer). */
function CustomInputRow({
  inputRef,
  index,
  value,
  placeholder,
  onChange,
  onFocus,
  onKeyDown,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Omit for a free-form question that has no numbered options. */
  index?: number;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}): JSX.Element {
  const hasValue = value.trim().length > 0;
  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target !== inputRef.current) {
          event.preventDefault();
          inputRef.current?.focus();
        }
      }}
      className={cn(
        "flex w-full cursor-text items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors focus-within:bg-accent",
        hasValue ? "bg-accent" : "hover:bg-accent",
      )}
    >
      {index !== undefined ? (
        <span className={cn("w-4 shrink-0 self-center text-sm font-medium", hasValue ? "text-foreground" : "text-muted-foreground")}>
          {index}.
        </span>
      ) : null}
      <Input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onChange={(event) => onChange(event.target.value)}
        className={INLINE_INPUT}
      />
    </div>
  );
}

function PlanReviewPanel({ request, onRespond }: { request: PermissionRequest; onRespond: Respond }): JSX.Element {
  const { t } = useTranslation("chat");
  const [feedback, setFeedback] = useState("");
  const plan = request.plan;
  const approve = useCallback(() => onRespond({ id: request.id, planAction: "approve" }), [onRespond, request.id]);
  const revise = useCallback(() => {
    if (feedback.trim()) onRespond({ id: request.id, planAction: "revise", value: feedback.trim() });
  }, [feedback, onRespond, request.id]);
  return (
    <div className={cn(CHAT_COLUMN_CLASS, "pb-4")}>
      <div className="overflow-hidden rounded-xl border border-border bg-card px-3 py-3 shadow-sm">
        <div className="flex items-center gap-3 pb-2">
          <span className="rounded-full border border-border px-2.5 py-0.5 text-xs font-semibold text-foreground">需要权限</span>
          <span className="text-sm font-semibold text-foreground">实施计划</span>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">‹　1 / 1　›</span>
        </div>
        <button type="button" onClick={approve} className="flex w-full items-center gap-3 rounded-lg bg-muted/70 px-3 py-2 text-left transition-colors hover:bg-muted">
          <span className="text-sm text-muted-foreground">1.</span>
          <span className="text-sm font-semibold text-foreground">批准</span>
          <span className="text-sm text-muted-foreground">退出计划模式并开始实施。</span>
        </button>
        <Input
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder={t("plan.revisionPlaceholder")}
          className="mt-2 h-9 border-0 bg-transparent px-3 text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:ring-0"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              revise();
            }
          }}
        />
        <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex min-w-0 flex-1 items-center gap-1.5"><span>ⓘ</span>使用 Tab / 上下键选择，回车或空格选中</span>
          <Button size="sm" variant="outline" onClick={() => onRespond({ id: request.id, planAction: "ignore" })}>忽略</Button>
          <Button size="sm" disabled={!feedback.trim()} onClick={revise}>提交</Button>
        </div>
      </div>
    </div>
  );
}

function ConfirmPanel({ request, onRespond }: { request: PermissionRequest; onRespond: Respond }): JSX.Element {
  const { t } = useTranslation("chat");
  const options = confirmOptions(t);
  const [active, setActive] = useState(0);
  const respond = useCallback((option: (typeof options)[number]) => onRespond({ id: request.id, ...option.response }), [onRespond, request.id]);

  usePanelKeys({
    count: options.length,
    active,
    setActive,
    onConfirm: () => respond(options[active]),
    onCancel: () => respond(options[options.length - 1]),
    onIndex: (index) => respond(options[index]),
  });

  return (
    <PanelShell
      tone="warning"
      title={request.title || t("permission.needApproval")}
      message={request.message}
      hint={t("permission.hintConfirm")}
      actions={
        <Button size="sm" onClick={() => respond(options[active])}>
          {t("permission.confirm")}
        </Button>
      }
    >
      <div role="listbox" aria-label={request.title || t("permission.needApproval")} className="flex flex-col gap-0.5">
        {options.map((option, index) => (
          <OptionRow
            key={option.label}
            index={index}
            label={option.label}
            description={option.description}
            selected={index === active}
            onSelect={() => respond(option)}
            onHover={() => setActive(index)}
          />
        ))}
      </div>
    </PanelShell>
  );
}

function SelectPanel({ request, onRespond }: { request: PermissionRequest; onRespond: Respond }): JSX.Element {
  const { t } = useTranslation("chat");
  const options = request.options ?? [];
  const details = request.optionDetails ?? [];
  const [active, setActive] = useState(0);
  const respond = useCallback((index: number) => {
    const value = options[index];
    if (value !== undefined) onRespond({ id: request.id, value });
  }, [onRespond, options, request.id]);

  usePanelKeys({
    count: options.length,
    active,
    setActive,
    onConfirm: () => respond(active),
    onCancel: () => onRespond({ id: request.id, cancelled: true }),
    onIndex: respond,
  });

  return (
    <PanelShell
      tone="primary"
      title={request.title || t("permission.needChoice")}
      message={request.message}
      hint={t("permission.hintSelect")}
      actions={
        <Button size="sm" variant="outline" onClick={() => onRespond({ id: request.id, cancelled: true })}>
          {t("permission.cancel")}
        </Button>
      }
    >
      {options.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">{t("permission.noOptions")}</p>
      ) : (
        <div role="listbox" aria-label={request.title || t("permission.needChoice")} className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
          {options.map((option, index) => (
            <OptionRow
              key={`${option}-${index}`}
              index={index}
              label={option}
              description={details[index]?.description}
              selected={index === active}
              onSelect={() => respond(index)}
              onHover={() => setActive(index)}
            />
          ))}
        </div>
      )}
    </PanelShell>
  );
}

function InputPanel({ request, onRespond }: { request: PermissionRequest; onRespond: Respond }): JSX.Element {
  const { t } = useTranslation("chat");
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = useCallback(() => onRespond({ id: request.id, value }), [onRespond, request.id, value]);
  const cancel = useCallback(() => onRespond({ id: request.id, cancelled: true }), [onRespond, request.id]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      } else if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancel, submit]);

  return (
    <PanelShell
      tone="primary"
      title={request.title || t("permission.needInput")}
      message={request.message}
      hint={t("permission.hintInput")}
      actions={
        <>
          <Button size="sm" variant="outline" onClick={cancel}>
            {t("permission.cancel")}
          </Button>
          <Button size="sm" disabled={!value.trim()} onClick={submit}>
            {t("permission.submit")}
          </Button>
        </>
      }
    >
      <CustomInputRow
        inputRef={inputRef}
        value={value}
        placeholder={request.placeholder ?? t("permission.placeholder")}
        onChange={setValue}
      />
    </PanelShell>
  );
}

/**
 * Shared keyboard behaviour for the list panels: ↑/↓ (or Tab) move, 1–9 jump,
 * Enter confirms the focused row, Esc cancels. The handler lives on `window` in
 * the capture phase because the composer — the usual focus owner — is hidden.
 */
function usePanelKeys({
  count,
  active,
  setActive,
  onConfirm,
  onCancel,
  onIndex,
}: {
  count: number;
  active: number;
  setActive: (updater: (current: number) => number) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onIndex: (index: number) => void;
}): void {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      } else if (event.key === "ArrowDown" || event.key === "ArrowRight" || event.key === "Tab") {
        if (count === 0) return;
        event.preventDefault();
        const step = event.shiftKey ? -1 : 1;
        setActive((current) => (current + step + count) % count);
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        if (count === 0) return;
        event.preventDefault();
        setActive((current) => (current - 1 + count) % count);
      } else if (event.key === "Enter") {
        event.preventDefault();
        onConfirm();
      } else {
        const index = Number(event.key) - 1;
        if (Number.isInteger(index) && index >= 0 && index < count) {
          event.preventDefault();
          onIndex(index);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, count, onCancel, onConfirm, onIndex, setActive]);
}

/**
 * Single-panel multi-question prompt (FastVibe's `questions` UI). One question at
 * a time; paging arrows sit top-right and answers return positionally as `{ answers }`.
 */
function QuestionsPanel({ request, onRespond }: { request: PermissionRequest; onRespond: Respond }): JSX.Element | null {
  const { t } = useTranslation("chat");
  const questions = useMemo(() => request.questions ?? [], [request.questions]);
  const count = questions.length;
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Array<string | null>>(() => questions.map(() => null));
  const [cursor, setCursor] = useState(0);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const current = questions[index];
  const options = current?.options ?? [];
  const allowOther = current?.allowOther ?? true;
  const freeForm = options.length === 0;
  const rowCount = freeForm ? 0 : options.length + (allowOther ? 1 : 0);
  const isLast = index >= count - 1;
  const typing = freeForm || customOpen;

  // Restore a previously recorded answer when paging back to a question.
  const goTo = useCallback(
    (next: number) => {
      const target = Math.min(Math.max(next, 0), Math.max(count - 1, 0));
      setIndex(target);
      const labels = questions[target]?.options ?? [];
      const stored = answers[target];
      const position = stored ? labels.indexOf(stored) : -1;
      setCursor(position >= 0 ? position : 0);
      const custom = Boolean(stored) && position < 0 && (questions[target]?.allowOther ?? true);
      setCustomOpen(custom);
      setCustomValue(custom && stored ? stored : "");
    },
    [answers, count, questions],
  );

  const record = useCallback(
    (value: string) => {
      setAnswers((prev) => prev.map((item, i) => (i === index ? value : item)));
      setCustomOpen(false);
      setCustomValue("");
      if (index < count - 1) goTo(index + 1);
    },
    [count, goTo, index],
  );

  const recordAndSubmit = useCallback(
    (value: string) => {
      const next = answers.map((item, i) => (i === index ? value : item));
      setAnswers(next);
      setCustomOpen(false);
      setCustomValue("");
      onRespond({ id: request.id, answers: next });
    },
    [answers, index, onRespond, request.id],
  );

  const submit = useCallback(() => onRespond({ id: request.id, answers }), [answers, onRespond, request.id]);
  const cancel = useCallback(() => onRespond({ id: request.id, cancelled: true }), [onRespond, request.id]);

  // The primary action mirrors Enter: commit the focused answer, then advance or submit.
  const primary = useCallback(() => {
    if (typing) {
      const value = customValue.trim();
      if (!value) return;
      if (isLast) recordAndSubmit(value);
      else record(value);
      return;
    }
    if (cursor < options.length) {
      const value = options[cursor];
      if (isLast) recordAndSubmit(value);
      else record(value);
      return;
    }
    if (rowCount > 0) {
      setCustomOpen(true);
      return;
    }
    if (isLast) submit();
    else goTo(index + 1);
  }, [cursor, customValue, goTo, index, isLast, options, record, recordAndSubmit, rowCount, submit, typing]);

  useEffect(() => {
    if (typing) inputRef.current?.focus();
  }, [typing, index]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (customOpen && !freeForm) {
          setCustomOpen(false);
          setCustomValue("");
        } else {
          cancel();
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        primary();
        return;
      }
      if (typing) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCursor((value) => (value + 1) % rowCount);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setCursor((value) => (value - 1 + rowCount) % rowCount);
      } else if (event.key === "ArrowLeft" && count > 1) {
        event.preventDefault();
        goTo(index - 1);
      } else if (event.key === "ArrowRight" && count > 1) {
        event.preventDefault();
        goTo(index + 1);
      } else {
        const digit = Number(event.key) - 1;
        if (Number.isInteger(digit) && digit >= 0 && digit < options.length) {
          event.preventDefault();
          setCursor(digit);
          if (isLast) recordAndSubmit(options[digit]);
          else record(options[digit]);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancel, count, freeForm, customOpen, goTo, index, isLast, options, primary, record, recordAndSubmit, rowCount, typing]);

  if (!current) return null;

  return (
    <PanelShell
      tone="primary"
      meta={current.header}
      title={current.question}
      aside={
        count > 1 ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={index === 0}
              title={t("permission.prev")}
              aria-label={t("permission.prev")}
              onClick={() => goTo(index - 1)}
            >
              <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} />
            </Button>
            <span className="min-w-9 text-center text-sm font-medium tabular-nums text-muted-foreground">
              {index + 1} / {count}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={isLast}
              title={t("permission.next")}
              aria-label={t("permission.next")}
              onClick={() => goTo(index + 1)}
            >
              <HugeiconsIcon strokeWidth={2} icon={ArrowRight01Icon} />
            </Button>
          </>
        ) : null
      }
      hint={typing ? t("permission.hintTyping") : count > 1 ? t("permission.hintMulti") : t("permission.hintSingle")}
      actions={
        <>
          <Button size="sm" variant="outline" onClick={cancel}>
            {t("permission.cancel")}
          </Button>
          <Button size="sm" disabled={typing && customValue.trim().length === 0} onClick={primary}>
            {isLast ? t("permission.submit") : t("permission.continue")}
          </Button>
        </>
      }
    >
      {freeForm ? (
        <CustomInputRow
          inputRef={inputRef}
          value={customValue}
          placeholder={t("permission.answerPlaceholder")}
          onChange={setCustomValue}
        />
      ) : (
        <div role="listbox" aria-label={current.question} className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
          {options.map((label, i) => (
            <OptionRow
              key={`${label}-${i}`}
              index={i}
              label={label}
              description={current.optionDetails?.[i]?.description}
              selected={cursor === i}
              onHover={() => setCursor(i)}
              onSelect={() => (isLast ? recordAndSubmit(label) : record(label))}
            />
          ))}
          {allowOther ? (
            customOpen ? (
              <CustomInputRow
                inputRef={inputRef}
                index={options.length + 1}
                value={customValue}
                placeholder={t("permission.otherPlaceholder")}
                onChange={setCustomValue}
              />
            ) : (
              <OptionRow
                index={options.length}
                label={t("permission.other")}
                selected={cursor === options.length}
                onHover={() => setCursor(options.length)}
                onSelect={() => setCustomOpen(true)}
              />
            )
          ) : null}
        </div>
      )}
    </PanelShell>
  );
}
