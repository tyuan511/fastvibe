import { useId, type JSX } from "react";
import { cn } from "@/lib/utils";

const MARBLE_POP = ["#5b1d99", "#0074b4", "#00b34c", "#ffd41f", "#fc6e3d"] as const;
const SIZE = 80;

function digit(value: number, position: number): number {
  return Math.floor(value / Math.pow(10, position)) % 10;
}

function unit(value: number, range: number, position?: number): number {
  const result = value % range;
  return position && digit(value, position) % 2 === 0 ? -result : result;
}

function hashSeed(seed: number): number {
  let value = seed | 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

/** Boring Avatars' Marble variant, kept local so avatars work offline. */
export function AgentAvatar({ seed = 0, size = "size-6", className }: { seed?: number; size?: string; className?: string }): JSX.Element {
  const id = useId().replaceAll(":", "");
  const value = hashSeed(seed);
  const colors = [
    MARBLE_POP[value % MARBLE_POP.length],
    MARBLE_POP[(value + 1) % MARBLE_POP.length],
    MARBLE_POP[(value + 2) % MARBLE_POP.length],
  ];
  const first = {
    x: unit(value, SIZE / 10, 1),
    y: unit(value, SIZE / 10, 2),
    scale: 1.2 + unit(value, SIZE / 20) / 10,
    rotate: unit(value, 360, 1),
  };
  const second = {
    x: unit(value * 2, SIZE / 10, 1),
    y: unit(value * 2, SIZE / 10, 2),
    scale: 1.2 + unit(value * 2, SIZE / 20) / 10,
    rotate: unit(value * 2, 360, 1),
  };
  const maskId = `agent-mask-${id}`;
  const filterId = `agent-filter-${id}`;
  return (
    <svg aria-hidden viewBox="0 0 80 80" className={cn("shrink-0", size, className)} fill="none">
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={SIZE} height={SIZE}>
        <rect width={SIZE} height={SIZE} rx={SIZE * 2} fill="white" />
      </mask>
      <g mask={`url(#${maskId})`}>
        <rect width={SIZE} height={SIZE} fill={colors[0]} />
        <path
          filter={`url(#${filterId})`}
          d="M32.414 59.35L50.376 70.5H72.5v-71H33.728L26.5 13.381l19.057 27.08L32.414 59.35z"
          fill={colors[1]}
          transform={`translate(${first.x} ${first.y}) rotate(${first.rotate} 40 40) scale(${first.scale})`}
        />
        <path
          filter={`url(#${filterId})`}
          style={{ mixBlendMode: "overlay" }}
          d="M22.216 24L0 46.75l14.108 38.129L78 86l-3.081-59.276-22.378 4.005 12.972 20.186-23.35 27.395L22.215 24z"
          fill={colors[2]}
          transform={`translate(${second.x} ${second.y}) rotate(${second.rotate} 40 40) scale(${second.scale})`}
        />
      </g>
      <defs>
        <filter id={filterId} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="7" result="effect1_foregroundBlur" />
        </filter>
      </defs>
    </svg>
  );
}
