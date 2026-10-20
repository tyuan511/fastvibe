import type { SlashCommand } from "@shared/types";

/** Keep draft whitespace intact: presentation parsers trim completed prompts. */
export function skillDraftOf(value: string, commands: readonly SlashCommand[], editingName = false): {
  text: string;
  skill?: { name: string };
} {
  const match = /^\/skill:([^\s]+)(?: ([\s\S]*))?$/.exec(value);
  // While the name is still being typed, the slash palette owns the input. A space
  // confirms it; a complete known name also covers a recalled skill-only prompt.
  if (!match) return { text: value };
  if (match[2] === undefined && (editingName || !commands.some((command) =>
    command.source === "skill" && command.name === `skill:${match[1]}`,
  ))) return { text: value };
  return { text: match[2] ?? "", skill: { name: match[1] } };
}

/** Store the command alongside the editable words without moving their caret. */
export function skillDraftText(skill: { name: string } | undefined, text: string): string {
  return skill ? `/skill:${skill.name} ${text}` : text;
}
