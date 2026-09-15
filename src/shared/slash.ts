/**
 * Built-in slash commands the GUI handles itself. The SDK's `prompt()` only
 * expands extension commands, skills and prompt templates — `/compact` would
 * otherwise go to the model as ordinary user text.
 */
export function parseCompactCommand(text: string): { instructions?: string } | null {
  const match = text.trim().match(/^\/compact(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const instructions = match[1]?.trim();
  return { instructions: instructions || undefined };
}
