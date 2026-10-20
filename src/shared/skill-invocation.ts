/**
 * A skill the person invoked on their own message.
 *
 * Two spellings reach the app and both mean the same thing:
 *
 * - the draft the composer sends — `/skill:office 帮我写个周报`;
 * - what the engine persists after expanding that command — the whole `SKILL.md`
 *   wrapped in a `<skill name="…" location="…">` block, with the person's own words
 *   after it.
 *
 * The second is what a transcript row holds, which is why the thread cannot show a
 * user prompt as typed: the body of a skill is 3 KB to 40 KB of instructions *for the
 * model*, and the person never wrote it. Everything that displays a prompt therefore
 * goes through here — the bubble, the queued row, the sidebar preview and the chat's
 * title — and draws a badge with the skill's name beside the words the person typed.
 *
 * The engine's copy is untouched: the model still reads the full skill. This is a
 * presentation rule, like the attachment block and the memory citation.
 */

/**
 * What the engine's expansion looks like. Mirrors the SDK's own `parseSkillBlock` —
 * exported so a test can pin the two against each other: if the engine ever changes the
 * wrapper, every skill row in the app would silently go back to showing a SKILL.md.
 */
export const SKILL_BLOCK = /^<skill name="([^"]+)" location="([^"]*)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** The command form the composer sends, before (or without) any expansion. */
const SKILL_COMMAND = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/;

/** The prefix the engine matches on. Kept separate so the draft check stays honest. */
const COMMAND_PREFIX = "/skill:";

export type SkillInvocation = {
  /** The skill's name, as `<skill name="…">` and `/skill:…` both carry it. */
  name: string;
  /** The `SKILL.md` path the engine recorded. Absent on a draft that was never expanded. */
  location?: string;
  /**
   * What the person wrote themselves — everything after the block or the command, and
   * including any attachment metadata still appended to the prompt.
   */
  args: string;
};

/** Parse either spelling. `null` when the text carries no skill invocation. */
export function parseSkillInvocation(text: string): SkillInvocation | null {
  const trimmed = text.trim();
  const block = SKILL_BLOCK.exec(trimmed);
  if (block) {
    return {
      name: block[1],
      location: block[2] || undefined,
      args: (block[4] ?? "").trim(),
    };
  }
  const command = SKILL_COMMAND.exec(trimmed);
  if (!command) return null;
  return { name: command[1], args: (command[2] ?? "").trim() };
}

/** A prompt that begins with the skill command, which is what the engine expands. */
export function isSkillCommand(text: string): boolean {
  return text.trimStart().startsWith(COMMAND_PREFIX);
}

/**
 * The prompt a row is *sent* as. A folded row's `text` holds only the person's words, so
 * editing or copying that turn has to put the command back — an edit that lost it would
 * re-run the turn without the skill it was written for.
 */
export function skillCommandOf(skill: { name: string } | undefined, text: string): string {
  if (!skill) return text;
  return text.trim() ? `${COMMAND_PREFIX}${skill.name} ${text}` : `${COMMAND_PREFIX}${skill.name}`;
}

/**
 * The text a prompt is drawn and re-sent as: the skill reduced to its command, and the
 * person's own words kept whole. An expanded block becomes the draft shape it came from,
 * so editing a turn, copying it, the sidebar preview and the generated title all agree
 * with what was actually typed — and an edit re-sends the same command, which re-expands
 * the skill on the new turn rather than silently dropping it.
 */
export function skillPromptText(text: string): string {
  const parsed = parseSkillInvocation(text);
  return parsed ? skillCommandOf(parsed, parsed.args) : text;
}

/** The person's own words only, which is what the bubble shows next to the badge. */
export function stripSkillInvocation(text: string): string {
  const parsed = parseSkillInvocation(text);
  return parsed ? parsed.args : text;
}

/**
 * Fold a skill invocation onto a transcript row. Returns the row's display text and the
 * badge to draw with it; a prompt with no skill is passed through untouched.
 */
export function skillDisplayOf(text: string): { text: string; skill?: { name: string; location?: string } } {
  const parsed = parseSkillInvocation(text);
  if (!parsed) return { text };
  return {
    text: parsed.args,
    skill: parsed.location ? { name: parsed.name, location: parsed.location } : { name: parsed.name },
  };
}
