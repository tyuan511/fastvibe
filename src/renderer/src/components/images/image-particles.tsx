import { memo, type CSSProperties, type JSX } from "react";
import { cn } from "@/lib/utils";

/**
 * The image-generation placeholder: a quiet mark — a breathing core between two arcs
 * turning in opposite directions. Plain SVG + CSS animations: no WebGL, no timers.
 * `active` keeps the old contract — the tile unmounts this once its image has faded in.
 */
export const ImageParticles = memo(function ImageParticles({
  className,
  style,
  active = true,
}: {
  className?: string;
  style?: CSSProperties;
  active?: boolean;
}): JSX.Element | null {
  if (!active) return null;
  return <div aria-hidden className={cn("pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden", className)} style={style}>
    <svg viewBox="0 0 96 96" className="size-16 text-primary">
      {/* Breathing core. */}
      <circle cx="48" cy="48" r="15" fill="currentColor" className="animate-pulse [animation-duration:2.4s] motion-reduce:animate-none" />
      {/* Two arcs of the inner ring chase each other round. */}
      <g className="animate-spin [animation-duration:2.8s] motion-reduce:animate-none" style={{ transformOrigin: "48px 48px" }}>
        <circle cx="48" cy="48" r="30" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="42 52.25 42 52.25" className="opacity-80" />
      </g>
      {/* The outer ring drifts the other way, lighter and sparser. */}
      <g className="animate-spin [animation-direction:reverse] [animation-duration:4.4s] motion-reduce:animate-none" style={{ transformOrigin: "48px 48px" }}>
        <circle cx="48" cy="48" r="39" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="14 67.66 14 67.66 14 67.68" className="opacity-40" />
      </g>
    </svg>
  </div>;
});
