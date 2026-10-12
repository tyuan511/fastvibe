/**
 * 立即 in flight, per conversation: from the click until the queued message's own run
 * starts, or until it turns out it will not.
 *
 * The message cannot start the moment it is asked for. The reply in flight has to be
 * stopped and settle first, and the prompt that follows still passes through session
 * setup, input hooks and memory retrieval before the SDK emits `agent_start`. Between
 * those two runs nothing is running — and reported as such, the chat went idle in the
 * middle of a send: the working row, the stop button and the sidebar mark all dropped,
 * and a state read taken in the gap offered 继续 on the reply that had just been cut.
 *
 * A span is what says the chat is still working across that gap. It is deliberately
 * not part of "is a run live": the queue drain and steering read that, and a span
 * exists precisely while no run is.
 */
export class SendNowSpans {
  readonly #spans = new Map<string, { queueId: string; replacing: boolean; armed: boolean }>();

  /**
   * Open a span for one queued message, replacing an earlier one (the newest click
   * wins). `replacing` says a run is live now: its settle is the first half of this
   * span, not the end of it.
   */
  begin(conversationId: string, queueId: string, replacing: boolean): void {
    this.#spans.set(conversationId, { queueId, replacing, armed: false });
  }

  /**
   * The queue has accepted the request (pause released, the row marked next).
   *
   * Until then the span must not be judged against the queue: 立即 is most often
   * pressed on a paused queue, and a snapshot taken before the pause is released
   * would read as "this message is being held" and close the span it just opened.
   */
  arm(conversationId: string, queueId: string): void {
    const span = this.#spans.get(conversationId);
    if (span?.queueId === queueId) span.armed = true;
  }

  has(conversationId: string): boolean {
    return this.#spans.has(conversationId);
  }

  /** The message an armed span is waiting on, for checking it against the queue. */
  target(conversationId: string): string | undefined {
    const span = this.#spans.get(conversationId);
    return span?.armed ? span.queueId : undefined;
  }

  /**
   * A run began (`agent_start` with none live). True when that closed the span: the
   * run it was waiting for is here, and the run flag carries the chat from now on.
   */
  runStarted(conversationId: string): boolean {
    const span = this.#spans.get(conversationId);
    if (!span || span.replacing) return false;
    this.#spans.delete(conversationId);
    return true;
  }

  /**
   * A run settled. `replaced` is the run that was in flight when the span opened —
   * the chat keeps working, the message is next. `ended` is a run that settled inside
   * the span without ever starting (the SDK settles a prompt it could not run), which
   * leaves nothing to wait for.
   */
  runSettled(conversationId: string): "replaced" | "ended" | undefined {
    const span = this.#spans.get(conversationId);
    if (!span) return undefined;
    if (span.replacing) {
      span.replacing = false;
      return "replaced";
    }
    this.#spans.delete(conversationId);
    return "ended";
  }

  /** Close the span. With `queueId`, only if it is still the one for that message. */
  end(conversationId: string, queueId?: string): boolean {
    const span = this.#spans.get(conversationId);
    if (!span || (queueId !== undefined && span.queueId !== queueId)) return false;
    this.#spans.delete(conversationId);
    return true;
  }

  clear(): void {
    this.#spans.clear();
  }
}
