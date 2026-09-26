import { useColorScheme } from "react-native";

/**
 * The phone's design tokens.
 *
 * Grouped-list layout: `background` is the page, `card` the raised surface a row or a
 * panel sits on, `field` the recessed one (a search box, an input, a code block). The
 * accent follows the app icon's blue, and each status colour has a `…Soft` twin for the
 * tinted fill behind it, so a badge never has to guess an alpha of its own.
 */
export type Palette = {
  dark: boolean;
  background: string;
  card: string;
  field: string;
  text: string;
  muted: string;
  subtle: string;
  border: string;
  separator: string;
  accent: string;
  accentSoft: string;
  accentText: string;
  /** The icon's gradient, start → end. */
  brand: [string, string];
  danger: string;
  dangerSoft: string;
  warning: string;
  warningSoft: string;
  success: string;
  successSoft: string;
  overlay: string;
  shadow: string;
};

const LIGHT: Palette = {
  dark: false,
  background: "#f3f4f7",
  card: "#ffffff",
  field: "#eceef2",
  text: "#0f1115",
  muted: "#6b7080",
  subtle: "#a0a4b0",
  border: "#e3e5ea",
  separator: "#eceef2",
  accent: "#2563eb",
  accentSoft: "#e7eefe",
  accentText: "#ffffff",
  brand: ["#3ba8ff", "#4a3cff"],
  danger: "#e5484d",
  dangerSoft: "#fdecec",
  warning: "#c27c00",
  warningSoft: "#fdf3dc",
  success: "#16a34a",
  successSoft: "#e5f6ea",
  overlay: "rgba(10, 12, 20, 0.42)",
  shadow: "#1a2340",
};

const DARK: Palette = {
  dark: true,
  background: "#0b0c0f",
  card: "#17181c",
  field: "#212329",
  text: "#f2f3f5",
  muted: "#9a9ea9",
  subtle: "#62666f",
  border: "#2a2c33",
  separator: "#212329",
  accent: "#5b8cff",
  accentSoft: "#1a2544",
  accentText: "#ffffff",
  brand: ["#3ba8ff", "#5b4bff"],
  danger: "#ff6369",
  dangerSoft: "#3a1a1c",
  warning: "#f5b73b",
  warningSoft: "#3a2d12",
  success: "#3dd68c",
  successSoft: "#12301f",
  overlay: "rgba(0, 0, 0, 0.6)",
  shadow: "#000000",
};

export function usePalette(): Palette {
  return useColorScheme() === "dark" ? DARK : LIGHT;
}

export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 } as const;

/**
 * A soft lift for *floating* surfaces only — the FAB, a dialog, a toast. Cards that sit
 * on the page (list rows, settings groups, the hero) are flat: tinted fill, no shadow.
 * Flat in dark mode too, where a shadow reads as a smudge.
 * `0` is barely there — for things that sit on the page rather than float over it (the
 * composer, the 正在工作 pill), where anything heavier drew the eye away from the reply.
 */
export function elevation(palette: Palette, level: 0 | 1 | 2 = 1) {
  if (palette.dark) return { elevation: level === 0 ? 0 : level * 2 };
  const shadow = [
    { opacity: 0.035, radius: 4, y: 1 },
    { opacity: 0.06, radius: 8, y: 2 },
    { opacity: 0.12, radius: 18, y: 6 },
  ][level]!;
  return {
    shadowColor: palette.shadow,
    shadowOpacity: shadow.opacity,
    shadowRadius: shadow.radius,
    shadowOffset: { width: 0, height: shadow.y },
    elevation: level === 0 ? 1 : level * 2,
  };
}

/**
 * A stable hue for a name — a provider or a project gets the same colour on every
 * screen and every launch, so it can be recognised before it is read.
 */
export function nameTint(name: string, palette: Palette): { fg: string; bg: string } {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  const hue = hash % 360;
  return palette.dark
    ? { fg: `hsl(${hue}, 70%, 72%)`, bg: `hsl(${hue}, 32%, 20%)` }
    : { fg: `hsl(${hue}, 62%, 38%)`, bg: `hsl(${hue}, 70%, 93%)` };
}

/** The one or two characters an avatar draws for a name: `Anthropic` → `A`, `智谱` → `智`. */
export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const words = trimmed.split(/[\s_\-/.]+/).filter(Boolean);
  if (words.length > 1 && /^[a-z]/i.test(words[0]!) && /^[a-z0-9]/i.test(words[1]!)) {
    return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  }
  return Array.from(trimmed)[0]!.toUpperCase();
}
