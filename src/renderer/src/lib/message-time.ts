/**
 * The transcript's timestamp format.
 *
 * A chat is not always read on the day it was written: reopening an old conversation
 * puts a week of turns on one screen, and a bare `14:32` on every footer reads as
 * "today" for all of them. So the date joins the time once the message is no longer
 * from today.
 *
 * Kept out of the component because this is the rule the helper encodes, not a detail
 * of `MessageActions` — and because it is the one part of the footer worth a unit test.
 */

/**
 * Separator between date and time. A space, not `·`: the footer already uses ` · ` to
 * attach 用时, and a second `·` in the same row would read as another field of that
 * kind. Neither locale needs a punctuation mark of its own in the chosen styles —
 * `zh-CN` renders `9月3日` and `en-US` `Sep 3`, both space-joined fine.
 */
const GAP = " ";

/** Is this timestamp on the reader's own calendar day? */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

/**
 * `14:32` for today, `9月3日 14:32` (English: `Sep 3, 2026`) for anything older — the
 * bare clock the transcript used to show, plus the date only when it is needed.
 *
 * The date style is the one `Intl` picks per locale rather than a hand-built pattern,
 * so a reader's own conventions (order, separators, spelled-out characters) survive:
 * `month: "short"` is `9月3日` in Chinese and `Sep 3` in English. The year joins in
 * only when the stamp is not from the current one — an old chat has to be placeable,
 * while repeating this year down every row of it would be noise.
 *
 * A *future* stamp also carries its date: that is a clock that disagrees with itself,
 * not a message from today.
 *
 * `now` is a parameter so the rule can be tested without freezing the clock.
 */
export function formatMessageTime(timestamp: number, locale: string, now: number = Date.now()): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  // 24-hour clock in the reader's own time zone; `h23` avoids locales that render
  // midnight as 24:00 under a bare `hour12: false`.
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const reference = new Date(now);
  // A stamp on the same calendar day gets the bare clock — unless it is *ahead* of now,
  // since a few hours into the future is still today and is a clock that disagrees with
  // itself rather than a message from today. Checked together rather than as one `||`,
  // which would short-circuit past the future case whenever the day matched.
  if (date.getTime() <= now && isSameDay(date, reference)) return time;
  const day = date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === reference.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${day}${GAP}${time}`;
}
