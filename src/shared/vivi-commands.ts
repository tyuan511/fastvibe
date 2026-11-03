import type { SlashCommand } from "./types.ts";

/** Vivi's main composer owns these commands; never borrow the ordinary chat roster. */
export function viviCommands(clearDescription: string): SlashCommand[] {
  return [{ name: "clear", description: clearDescription, source: "vivi" }];
}

/** Paths such as /Users/me/file remain ordinary text. Command-looking input is local. */
export function viviCommand(text: string): "clear" | "unsupported" | undefined {
  const value = text.trim();
  if (value === "/clear") return "clear";
  if (/^\/(?:[a-z][\w:-]*)?(?=\s|$)/i.test(value)) return "unsupported";
  return undefined;
}
