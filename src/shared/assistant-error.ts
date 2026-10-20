/**
 * A failed reply, presented as a headline plus the provider's own words.
 *
 * The engine hands the renderer `errorMessage` as the provider wrote it, and there are two
 * shapes worth designing for, not one:
 *
 *   `429: {"message":"Allocated quota exceeded, please increase your quota limit. For
 *   details, see: https://…","id":"14fc57c3-…","type":"insufficient_quota"}`
 *
 *   `503 data: {"error":{"code":"ServiceUnavailable",…}}` — and an SDK setup error, which is
 *   three paragraphs of advice ending in a `file:///…` path:
 *
 *   `No API key found for anthropic.\n\nUse /login to log into a provider via OAuth or API
 *   key. See:\n  /Users/me/code/fastvibe/node_modules/…/docs/providers.md`
 *
 * Drawn as one run of text each of these is a wall: the JSON has to be parsed by the reader,
 * and the three-paragraph one has a bare filesystem path in it that is wider than the column.
 * So the shape is split once, here, where both renderers and the tests can read it the same
 * way. Nothing is thrown away: the detail is what 复制 copies.
 */

/** How the failure reads before any provider detail. */
export type ErrorShape = {
  /** The provider's text with the noise stripped: what a person reads first. */
  headline: string;
  /** The provider's following sentences — advice, remediation — each already one line. */
  body: string[];
  /** The raw provider output, verbatim, shown behind a disclosure and what 复制 copies. */
  detail: string;
  /** HTTP-ish status lifted from the text, when there is one. */
  status?: number;
  /**
   * A gateway's machine-readable `type` / `code` (`insufficient_quota`, `rate_limit_error`).
   * Shown as a chip, because it is what a person searching for the cause would type.
   */
  code?: string;
};

const STATUS_PREFIX = /^(?:HTTP\s*)?(\d{3})\b\s*(?:status code)?\s*[:：-]?\s*/i;
const STATUS_PARENS = /\((\d{3})\)/;
const STATUS_CODE_WORD = /\b(\d{3})\s+status code\b/i;

function firstMessageField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "detail", "error_description", "msg"]) {
    const text = record[key];
    if (typeof text === "string" && text.trim()) return text.trim();
    // OpenAI's and Anthropic's error envelopes nest one level: `{ error: { message } }`.
    const nested = firstMessageField(text);
    if (nested) return nested;
  }
  const nested = firstMessageField(record.error);
  return nested;
}

function codeField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["code", "type", "error_code"]) {
    const text = record[key];
    if (typeof text === "string" && text.trim() && text.length <= 64) return text.trim();
  }
  return codeField(record.error);
}

/**
 * Text left once the status code has been lifted out, or `""` when it was all the provider
 * had to say (`413 status code (no body)`, `502 `).
 */
function withoutStatus(text: string): string {
  return text
    .replace(STATUS_PREFIX, "")
    .replace(/\(?\bno body\b\)?/i, "")
    .replace(/^[\s(\[]+|[\s)\]]+$/g, "")
    .trim();
}

/** The JSON body inside an error string, wherever the provider put it. */
function jsonBody(text: string): { value: unknown; start: number; end: number } | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (value && typeof value === "object") return { value, start, end: end + 1 };
    } catch {
      // A truncated or escaped body: fall through to an earlier `}`.
    }
    if (end <= start) break;
  }
  return undefined;
}

/**
 * JSON pretty-printed, one key per line, so the detail behind the disclosure is readable
 * instead of being a single 600-character line. Anything that is not an object is returned
 * untouched.
 */
export function prettyProviderDetail(text: string): string {
  const raw = text.trim();
  if (!raw) return "";
  const body = raw.startsWith("{")
    ? (() => {
        try {
          return { value: JSON.parse(raw), start: 0, end: raw.length };
        } catch {
          return undefined;
        }
      })()
    : jsonBody(raw);
  if (!body) return raw;
  const prefix = raw.slice(0, body.start).trim().replace(STATUS_PREFIX, "").trim();
  let pretty = raw.slice(body.start, body.end);
  try {
    pretty = JSON.stringify(body.value, null, 2);
  } catch {
    // Keep the original slice; a circular or exotic value is still the provider's words.
  }
  const suffix = raw.slice(body.end).trim();
  return [prefix, pretty, suffix].filter(Boolean).join("\n");
}

/**
 * Lines a person can read: trailing whitespace gone, runs of blank lines collapsed to one,
 * and any line indented by a whole path or a URL pulled out on its own.
 *
 * The SDK's setup errors end in a two-space-indented `file:///Users/…/docs/providers.md`,
 * and a git failure arrives as an indented stack. Both are *lines*, not paragraphs, and a
 * line that long is the case that used to deform the card: no wrap point, so the bubble grew
 * past the column. They are kept as their own line here and drawn broken in the component.
 */
function readableLines(text: string): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, all) => !(line.trim() === "" && (index === 0 || index === all.length - 1)));
  const collapsed: string[] = [];
  for (const line of lines) {
    if (line.trim() === "" && collapsed[collapsed.length - 1]?.trim() === "") continue;
    collapsed.push(line.trim() === "" ? "" : line.trim());
  }
  return collapsed;
}

/** The text before the body, minus the status the chip already states. */
function headlineOf(text: string, status?: number): { headline: string; body: string[] } {
  const cleaned = readableLines(withoutStatus(text));
  const first = cleaned[0]?.trim() ?? "";
  const cut = first.length > 240 ? `${first.slice(0, 240).trimEnd()}…` : first;
  // The status is drawn as its own chip, so a bare `429` left in the text is a duplicate.
  const headline = status !== undefined && cut === String(status) ? "" : cut;
  const body = cleaned.slice(1);
  while (body.length > 0 && body[0].trim() === "") body.shift();
  return { headline, body };
}

/**
 * Split an engine error string into the line a person reads, the advice under it, and the
 * detail behind the disclosure.
 *
 * Only the *first* sentence of a provider message becomes the headline: the rest of a
 * gateway's text is documentation links and allocation advice, which read as the body rather
 * than as the transcript's most prominent red line.
 */
export function describeAssistantError(raw: string): ErrorShape {
  const detail = raw.trim();
  if (!detail) return { headline: "", body: [], detail: "" };

  // A status a person can act on: a leading `429:`, a parenthesised `(429)`, or the SDK's
  // `413 status code`. Any other three-digit run is somebody's line number.
  const statusMatch = detail.match(STATUS_PREFIX) ?? detail.match(STATUS_PARENS) ?? detail.match(STATUS_CODE_WORD);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  const json = jsonBody(detail);
  const code = json ? codeField(json.value) : undefined;
  const message = json ? firstMessageField(json.value) : undefined;

  if (message) {
    // A provider sentence can wander for paragraphs (an allocation notice with its own
    // remediation steps). One line is the headline; the whole sentence stays in the detail.
    const sentences = message.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
    const first = sentences[0]?.trim() ?? "";
    const headline = first.length > 240 ? `${first.slice(0, 240).trimEnd()}…` : first;
    const body = readableLines(sentences.slice(1).join(" ")).filter((line) => line !== "");
    return { headline, body, detail: prettyProviderDetail(detail), status, code };
  }

  const { headline, body } = headlineOf(detail, status);
  return { headline, body, detail: prettyProviderDetail(detail), status, code };
}

/**
 * Whether the card has a disclosure worth opening: something the visible rows do not already
 * say. A `Connection error.` has none — opening it would print the same sentence twice.
 */
export function errorHasDetail(shape: ErrorShape): boolean {
  const shown = [shape.headline, ...shape.body].join("\n").trim();
  return shape.detail.trim() !== shown;
}
