import { hashState } from "./trace.ts";
import type { JsonValue } from "./protocol.ts";

/**
 * Pure pieces of the browser_task loop that are not the decision itself
 * (docs/decision-layer.md §7.1): detecting a loop, and typing text the goal already
 * spells out without asking a model to "generate" it.
 */

/**
 * Stops a run that keeps taking the same action on the same observed state.
 *
 * If an action left the page exactly as it was, repeating it is not progress. The pilot
 * showed the pattern: an in-page anchor clicked three times in a row by a reviewer that
 * could not tell the click had done nothing. The key is the observed state plus the
 * action, so scrolling down a long page (the state changes each time) is not a loop,
 * while re-clicking a dead link is.
 */
export class LoopGuard {
  readonly #seen = new Map<string, number>();
  readonly #maxRepeats: number;

  /** `maxRepeats`: how many times one action may be taken on one state. */
  constructor(maxRepeats = 2) {
    this.#maxRepeats = Math.max(1, maxRepeats);
  }

  /**
   * Record an action about to be taken. Returns `false` when it would exceed the limit —
   * the caller hands back instead of executing it.
   */
  admit(state: JsonValue, operation: string, target: string | undefined): boolean {
    const key = `${hashState(state)}\u0000${operation}\u0000${target ?? ""}`;
    const count = (this.#seen.get(key) ?? 0) + 1;
    if (count > this.#maxRepeats) return false;
    this.#seen.set(key, count);
    return true;
  }
}

const QUOTED = [/“([^”]+)”/g, /"([^"]+)"/g, /「([^」]+)」/g, /『([^』]+)』/g, /‘([^’]+)’/g];

/**
 * The text to type, when the goal already states it: exactly one distinct quoted string.
 *
 * A goal like `search for "OpenAI GPT-6 Sol"` leaves nothing to generate, and asking a
 * model costs a round trip that can only return the same words, or different ones. Two or
 * more distinct literals are ambiguous — which goes into which field — so they return
 * `null` and the caller asks the model with the field's context. A literal already typed
 * in this run is not offered again: a second field wants something else.
 */
export function literalText(goal: string, alreadyTyped: readonly string[] = []): string | null {
  const found = new Set<string>();
  for (const pattern of QUOTED) {
    for (const match of goal.matchAll(pattern)) {
      const value = match[1].trim();
      if (value) found.add(value);
    }
  }
  if (found.size !== 1) return null;
  const [value] = found;
  return alreadyTyped.includes(value) ? null : value;
}
