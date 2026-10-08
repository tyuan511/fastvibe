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

/**
 * `/handoff` is an extension command, not a prompt. The goal is everything
 * after the command, including newlines. A bare `/handoff` asks for one.
 */
export function parseHandoffCommand(text: string): { goal?: string } | null {
  const match = text.trim().match(/^\/handoff(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const goal = match[1]?.trim();
  return { goal: goal || undefined };
}
