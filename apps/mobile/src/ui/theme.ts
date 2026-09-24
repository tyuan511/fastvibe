import { useColorScheme } from "react-native";

export type Palette = {
  background: string;
  text: string;
  muted: string;
  card: string;
  border: string;
  accent: string;
  accentText: string;
  danger: string;
  warning: string;
};

export function usePalette(): Palette {
  const dark = useColorScheme() === "dark";
  if (dark) {
    return {
      background: "#000000",
      text: "#f5f5f7",
      muted: "#a1a1a6",
      card: "#1c1c1e",
      border: "#2c2c2e",
      accent: "#0a84ff",
      accentText: "#ffffff",
      danger: "#ff453a",
      warning: "#ffd60a",
    };
  }
  return {
    background: "#ffffff",
    text: "#111111",
    muted: "#6e6e73",
    card: "#f4f4f5",
    border: "#e5e5ea",
    accent: "#007aff",
    accentText: "#ffffff",
    danger: "#ff3b30",
    warning: "#b58100",
  };
}
