/**
 * Catching a model that has stopped writing and started repeating itself.
 *
 * A degenerate response falls into a strict cycle: the same block of characters, over
 * and over, byte for byte. Nothing downstream reads that as a failure — every delta is a
 * well-formed one — and the run only ends when the output budget does, which for these
 * models is a hundred thousand tokens away. A real one streamed 376 KB of the same 406
 * characters for 27 minutes, and a second streamed 63 KB of a 24-character cycle, before
 * anything stopped them.
 *
 * The test is periodicity, not "the same sentence twice": two identical paragraphs are
 * something people write, and a tail of eight identical copies is not. The *smallest*
 * period is used, so a loop whose block itself contains a cycle reads as one verdict.
 */

/**
 * How much of the stream is examined.
 *
 * A period this long repeated eight times is already 16 KB of text with nothing new in
 * it; a longer window would only buy a slower scan.
 */
export const OUTPUT_REPETITION_WINDOW = 16_384;

/** Copies of the same block required before the stream is called degenerate. */
export const OUTPUT_REPETITION_MIN_REPEATS = 8;

/** Characters that must actually repeat: a repeated 20-character line is not a loop. */
export const OUTPUT_REPETITION_MIN_CHARS = 2_000;

/** The window is re-examined every this many characters, never on every token. */
export const OUTPUT_REPETITION_CHECK_STEP = 1_024;

export type OutputRepetition = {
  /** Length of the block being repeated. */
  period: number;
  /** How many copies of it the examined tail holds. */
  repeats: number;
};

/** The repetition a streamed tail has fallen into, if any. */
export function findOutputRepetition(text: string): OutputRepetition | undefined {
  const tail = text.length > OUTPUT_REPETITION_WINDOW ? text.slice(-OUTPUT_REPETITION_WINDOW) : text;
  const length = tail.length;
  if (length < OUTPUT_REPETITION_MIN_CHARS) return undefined;
  const period = smallestPeriod(tail);
  const repeats = Math.floor(length / period);
  if (repeats < OUTPUT_REPETITION_MIN_REPEATS) return undefined;
  // The last copy may be a partial one, so only whole repeats are evidence.
  return (repeats - 1) * period >= OUTPUT_REPETITION_MIN_CHARS ? { period, repeats } : undefined;
}

/**
 * Accumulate one streamed block of text and answer at most one verdict.
 *
 * Stateful because the scan is periodic: the tail is re-examined once a thousand more
 * characters have arrived, which is what keeps a per-token handler cheap. Deltas in
 * between are held aside and appended to the tail at that point, so the string is
 * copied once per kilobyte rather than once per token.
 */
export class OutputRepetitionWatch {
  #tail = "";
  #pending = "";
  #sinceCheck = 0;
  #reported = false;

  /** Feed one delta; a verdict comes back once, on the delta that proves the loop. */
  push(delta: string): OutputRepetition | undefined {
    if (this.#reported) return undefined;
    this.#pending += delta;
    this.#sinceCheck += delta.length;
    if (this.#sinceCheck < OUTPUT_REPETITION_CHECK_STEP) return undefined;
    this.#tail = (this.#tail + this.#pending).slice(-OUTPUT_REPETITION_WINDOW);
    this.#pending = "";
    this.#sinceCheck = 0;
    const verdict = findOutputRepetition(this.#tail);
    if (verdict) this.#reported = true;
    return verdict;
  }

  /** Forget the stream: a new message is not a continuation of the last one. */
  reset(): void {
    this.#tail = "";
    this.#pending = "";
    this.#sinceCheck = 0;
    this.#reported = false;
  }
}

/** The shortest `p` with `text[i] === text[i + p]` throughout — the border rule. */
function smallestPeriod(text: string): number {
  const length = text.length;
  const border = new Int32Array(length);
  for (let i = 1; i < length; i += 1) {
    let matched = border[i - 1];
    while (matched > 0 && text[i] !== text[matched]) matched = border[matched - 1];
    if (text[i] === text[matched]) matched += 1;
    border[i] = matched;
  }
  return length - border[length - 1];
}
