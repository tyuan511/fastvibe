/**
 * Fewer `toolcall_delta` events for a tool call whose arguments are large.
 *
 * Each delta is forwarded with the call's *whole* arguments parsed so far
 * (`slimStreamEvent` keeps `partial.content[index]`), because that is what a client draws
 * and what replaces the previous one. Streaming a `write` therefore sends O(n²) bytes: a
 * 100 KB file in 40-character deltas is ~2,500 events and ~127 MB through the event bus,
 * IPC to every window and, with a phone connected, the WebRTC channel — where a relay is
 * metered against the account. Each delta supersedes the one before it, so only the latest
 * matters: within a window the newest is held and the older ones are dropped, which loses
 * nothing a client could show.
 *
 * The window grows with the arguments, ~1 ms per 100 characters received for that call,
 * between 100 ms and 1 s: a short command still updates at a reading pace, and a long
 * file's arguments cross the boundary a bounded number of times per second rather than
 * once per delta. A held delta is delivered when its window ends, and before any other
 * event of the same owner (`release`), so ordering and the final state are unchanged —
 * the call's `toolcall_end` follows its last delta exactly as before.
 */

const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 1_000;
const CHARS_PER_MS = 100;

type Deliver = (payload: Record<string, unknown>) => void;

type Slot = {
  /** Which content block of the message is streaming; a new one starts its own window. */
  index: unknown;
  /** Argument characters received for this call so far. */
  chars: number;
  sentAt: number;
  held?: { payload: Record<string, unknown>; deliver: Deliver };
  timer?: ReturnType<typeof setTimeout>;
};

export type ThrottleClock = {
  now(): number;
  setTimeout(run: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

const systemClock: ThrottleClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer),
};

/** The streamed tool-argument fragment an SDK event carries, or `undefined` for any other event. */
function toolDelta(event: unknown): { index: unknown; delta: string } | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const record = event as Record<string, unknown>;
  if (record.type !== "message_update") return undefined;
  const inner = record.assistantMessageEvent;
  if (typeof inner !== "object" || inner === null) return undefined;
  const type = (inner as Record<string, unknown>).type;
  if (type !== "toolcall_delta" && type !== "tool_call_delta") return undefined;
  const delta = (inner as Record<string, unknown>).delta;
  return { index: (inner as Record<string, unknown>).contentIndex, delta: typeof delta === "string" ? delta : "" };
}

export function toolDeltaInterval(chars: number): number {
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(chars / CHARS_PER_MS)));
}

export class ToolDeltaThrottle {
  #slots = new Map<string, Slot>();
  #clock: ThrottleClock;

  constructor(clock: ThrottleClock = systemClock) {
    this.#clock = clock;
  }

  /**
   * Take a stream event for `owner` (a conversation or a delegated run). Returns `false` for
   * anything that is not a tool-argument delta — the caller delivers it itself, after
   * `release`. A delta is always taken: delivered now through `deliver`, or held.
   */
  offer(owner: string, event: unknown, payload: Record<string, unknown>, deliver: Deliver): boolean {
    const delta = toolDelta(event);
    if (!delta) return false;
    let slot = this.#slots.get(owner);
    if (slot && slot.index !== delta.index) {
      this.release(owner);
      slot = undefined;
    }
    if (!slot) {
      slot = { index: delta.index, chars: 0, sentAt: Number.NEGATIVE_INFINITY };
      this.#slots.set(owner, slot);
    }
    slot.chars += delta.delta.length;
    const now = this.#clock.now();
    const interval = toolDeltaInterval(slot.chars);
    if (!slot.held && now - slot.sentAt >= interval) {
      slot.sentAt = now;
      deliver(payload);
      return true;
    }
    slot.held = { payload, deliver };
    if (slot.timer === undefined) {
      const target = slot;
      target.timer = this.#clock.setTimeout(() => {
        target.timer = undefined;
        this.#flush(target);
      }, Math.max(0, slot.sentAt + interval - now));
    }
    return true;
  }

  /** Deliver what `owner` holds, now, and start its next call afresh. Call before any of its other events. */
  release(owner: string): void {
    const slot = this.#slots.get(owner);
    if (!slot) return;
    this.#slots.delete(owner);
    if (slot.timer !== undefined) this.#clock.clearTimeout(slot.timer);
    slot.timer = undefined;
    this.#flush(slot);
  }

  /** Forget `owner` without delivering anything: its session is gone. */
  drop(owner: string): void {
    const slot = this.#slots.get(owner);
    if (!slot) return;
    this.#slots.delete(owner);
    if (slot.timer !== undefined) this.#clock.clearTimeout(slot.timer);
  }

  #flush(slot: Slot): void {
    const held = slot.held;
    if (!held) return;
    slot.held = undefined;
    slot.sentAt = this.#clock.now();
    held.deliver(held.payload);
  }
}
