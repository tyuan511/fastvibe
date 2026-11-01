import type { JSX } from "react";
import { agentAvatarVariant } from "@shared/agent-identity";
import { cn } from "@/lib/utils";

const BASE_COLORS = [
  "text-primary", "text-info", "text-success", "text-warning",
  "text-destructive", "text-chart-1", "text-chart-2", "text-chart-3",
] as const;
const ACCENT_COLORS = [
  "fill-info", "fill-success", "fill-warning", "fill-primary",
  "fill-chart-1", "fill-chart-2", "fill-chart-3", "fill-destructive",
] as const;
const SECONDARY_COLORS = [
  "fill-success", "fill-warning", "fill-primary", "fill-info",
  "fill-chart-2", "fill-chart-3", "fill-destructive", "fill-chart-1",
] as const;

const PATTERNS = [
  ["00122000", "01211120", "11111110", "11111111", "11111111", "11111101", "02111100", "00111000"],
  ["10000001", "01222210", "00111100", "00011000", "00011000", "00111100", "01222210", "10000001"],
  ["00110000", "01122000", "11221100", "00111111", "00011111", "00001111", "00000121", "00000012"],
  ["11111111", "10000001", "10111101", "10100101", "10100101", "10111101", "10000001", "11111111"],
  ["00011000", "00111100", "01111110", "11111111", "11111111", "01111110", "00111100", "00011000"],
  ["11000011", "01100110", "00111100", "00011000", "00011000", "00111100", "01100110", "11000011"],
  ["11110000", "11111000", "01111100", "00111110", "00011111", "00001111", "00000111", "00000011"],
  ["10011001", "01100110", "00111100", "01111110", "01111110", "00111100", "01100110", "10011001"],
] as const;

/** A small mosaic avatar. The seed is persisted on the thread. */
export function AgentAvatar({ seed = 0, size = "size-6", className }: { seed?: number; size?: string; className?: string }): JSX.Element {
  const variant = agentAvatarVariant(seed);
  const pattern = PATTERNS[variant];
  return (
    <svg aria-hidden viewBox="0 0 32 32" className={cn("shrink-0", size, BASE_COLORS[variant], className)}>
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="currentColor" opacity=".12" />
      {pattern.flatMap((row, y) => [...row].map((cell, x) => {
        if (cell === "0") return null;
        const className = cell === "1" ? ACCENT_COLORS[variant] : SECONDARY_COLORS[variant];
        return <rect key={`${x}:${y}`} x={3.5 + x * 3.15} y={3.5 + y * 3.15} width="2.55" height="2.55" rx=".55" className={className} />;
      }))}
    </svg>
  );
}
