import { useId, type CSSProperties, type JSX } from "react";
import { cn } from "@/lib/utils";
import "./fastvibe-mascot.css";

export type FastVibeMascotStatus = "idle" | "thinking" | "working" | "waiting" | "success" | "error";
export type FastVibeMascotPalette = "sky" | "grape" | "mint" | "peach" | "cloud";

interface MascotColors {
  /** The body is lit from the top left: `light` → `mid` → `deep` toward the lower right. */
  light: string;
  mid: string;
  deep: string;
  feet: string;
  ink: string;
  blush: string;
}

export const MASCOT_PALETTES: Record<FastVibeMascotPalette, MascotColors> = {
  sky: { light: "#a6e6ff", mid: "#4f9bff", deep: "#4a3ee0", feet: "#3b31c4", ink: "#151a4f", blush: "#ff8cc8" },
  grape: { light: "#ecd4ff", mid: "#a670ff", deep: "#5a2fd6", feet: "#4824b4", ink: "#25124f", blush: "#ff8cc8" },
  mint: { light: "#d2fff1", mid: "#3fd2b2", deep: "#14898d", feet: "#0e7275", ink: "#0d2d38", blush: "#ff9ab8" },
  peach: { light: "#ffe6cc", mid: "#ff9b72", deep: "#e5506c", feet: "#c33f58", ink: "#3d1426", blush: "#ff6f9c" },
  cloud: { light: "#ffffff", mid: "#f3f6ff", deep: "#c8d3ff", feet: "#b1bff9", ink: "#17205e", blush: "#ff9fcd" },
};

const SPARK_LIGHT = "#fff6c2";
const SPARK = "#ffd23f";
const SPARK_OFF_LIGHT = "#eef1f6";
const SPARK_OFF = "#b9c1d3";
const TONGUE = "#ff7a9c";

const BODY = "M64 36C90 36 108 56 108 82C108 104 92 112 64 112C36 112 20 104 20 82C20 56 38 36 64 36Z";
const EYE_Y = 81;
const EYE_X = [47, 81] as const;

/** A four-point sparkle with pinched sides; its tips are rounded by a stroke of the same paint. */
function sparkle(cx: number, cy: number, r: number, degrees: number): string {
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const at = (x: number, y: number): string => `${(cx + x * cos - y * sin).toFixed(2)} ${(cy + x * sin + y * cos).toFixed(2)}`;
  const k = r * 0.26;
  return `M${at(0, -r)}Q${at(k, -k)} ${at(r, 0)}Q${at(k, k)} ${at(0, r)}Q${at(-k, k)} ${at(-r, 0)}Q${at(-k, -k)} ${at(0, -r)}Z`;
}

const SPARKLE = sparkle(88, 22, 11.5, 15);
const MINI_SPARKLES = [sparkle(105, 38, 4.4, 15), sparkle(72.5, 10.5, 3.4, 15)];

function Eyes({ status, ink }: { status: FastVibeMascotStatus; ink: string }): JSX.Element {
  if (status === "success") {
    return (
      <g fill="none" stroke={ink} strokeWidth={3.6} strokeLinecap="round">
        {EYE_X.map((x) => <path key={x} d={`M${x - 6.5} ${EYE_Y + 3}Q${x} ${EYE_Y - 7} ${x + 6.5} ${EYE_Y + 3}`} />)}
      </g>
    );
  }
  if (status === "error") {
    return (
      <g fill="none" stroke={ink} strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round">
        <path d={`M${EYE_X[0] - 5} ${EYE_Y - 5}L${EYE_X[0] + 4.5} ${EYE_Y}L${EYE_X[0] - 5} ${EYE_Y + 5}`} />
        <path d={`M${EYE_X[1] + 5} ${EYE_Y - 5}L${EYE_X[1] - 4.5} ${EYE_Y}L${EYE_X[1] + 5} ${EYE_Y + 5}`} />
      </g>
    );
  }
  return (
    <g transform={status === "thinking" ? "translate(2.6 -2.6)" : undefined}>
      <g className="fv-mascot-eyes">
        {EYE_X.map((x) => (
          <g key={x}>
            <ellipse cx={x} cy={EYE_Y} rx={6.4} ry={8.2} fill={ink} />
            <circle cx={x + 2.3} cy={EYE_Y - 3.3} r={2.6} fill="#fff" />
            <circle cx={x - 2.4} cy={EYE_Y + 3.6} r={1.2} fill="#fff" opacity={0.85} />
          </g>
        ))}
      </g>
    </g>
  );
}

function Mouth({ status, ink }: { status: FastVibeMascotStatus; ink: string }): JSX.Element {
  const line = { fill: "none", stroke: ink, strokeLinecap: "round" } as const;
  switch (status) {
    case "success":
      return (
        <>
          <path d="M57 88.6Q64 90.4 71 88.6Q70.4 98.4 64 98.4Q57.6 98.4 57 88.6Z" fill={ink} />
          <path d="M60.2 95.4Q64 92.4 67.8 95.4Q66.4 98.4 64 98.4Q61.6 98.4 60.2 95.4Z" fill={TONGUE} />
        </>
      );
    case "waiting":
      return <ellipse cx={64} cy={92} rx={2.8} ry={3.3} fill={ink} />;
    case "thinking":
      return <path d="M60 92q2-1.8 4 0t4 0" {...line} strokeWidth={2.4} />;
    case "error":
      return <path d="M58.5 94q2.75-2.6 5.5 0t5.5 0" {...line} strokeWidth={2.6} />;
    case "working":
      return (
        <>
          <ellipse cx={67.4} cy={93.4} rx={2.4} ry={2.9} fill={TONGUE} />
          <path d="M59.5 90.5Q64 95 68.5 90.5" {...line} strokeWidth={2.8} />
        </>
      );
    default:
      return <path d="M59.5 90.5Q64 95 68.5 90.5" {...line} strokeWidth={2.8} />;
  }
}

/**
 * Vivi, the bot character and desktop pet: a soft blob with a sparkle floating above it.
 * Each `status` is one agent state, drawn with its own face and motion.
 */
export function FastVibeMascot({
  status = "idle",
  palette = "sky",
  motion = true,
  shadow = false,
  size = "size-6",
  className,
  style,
  label,
}: {
  status?: FastVibeMascotStatus;
  palette?: FastVibeMascotPalette;
  /** Off for static uses (lists of many avatars, the app icon). */
  motion?: boolean;
  /** A soft ground shadow, for large standalone uses. */
  shadow?: boolean;
  size?: string;
  className?: string;
  style?: CSSProperties;
  label?: string;
}): JSX.Element {
  const uid = useId().replaceAll(":", "");
  const ref = (name: string): string => `fv-mascot-${uid}-${name}`;
  const colors = MASCOT_PALETTES[palette];
  const error = status === "error";

  return (
    <svg
      viewBox="0 0 128 128"
      className={cn("fv-mascot shrink-0", size, className)}
      style={style}
      data-status={status}
      data-motion={motion ? undefined : "off"}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <defs>
        <radialGradient id={ref("body")} cx="0.36" cy="0.26" r="0.86">
          <stop offset="0" stopColor={colors.light} />
          <stop offset="0.48" stopColor={colors.mid} />
          <stop offset="1" stopColor={colors.deep} />
        </radialGradient>
        <radialGradient id={ref("shine")}>
          <stop offset="0" stopColor="#fff" stopOpacity={0.9} />
          <stop offset="1" stopColor="#fff" stopOpacity={0} />
        </radialGradient>
        <radialGradient id={ref("blush")}>
          <stop offset="0" stopColor={colors.blush} stopOpacity={0.85} />
          <stop offset="1" stopColor={colors.blush} stopOpacity={0} />
        </radialGradient>
        <linearGradient id={ref("spark")} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={error ? SPARK_OFF_LIGHT : SPARK_LIGHT} />
          <stop offset="0.55" stopColor={error ? SPARK_OFF : SPARK} />
        </linearGradient>
        <radialGradient id={ref("glow")}>
          <stop offset="0" stopColor={SPARK} stopOpacity={0.55} />
          <stop offset="1" stopColor={SPARK} stopOpacity={0} />
        </radialGradient>
        {shadow ? (
          <radialGradient id={ref("ground")}>
            <stop offset="0" stopColor={colors.deep} stopOpacity={0.28} />
            <stop offset="1" stopColor={colors.deep} stopOpacity={0} />
          </radialGradient>
        ) : null}
      </defs>
      {shadow ? <ellipse className="fv-mascot-ground" cx={64} cy={117} rx={42} ry={6} fill={`url(#${ref("ground")})`} /> : null}
      <g className="fv-mascot-figure">
        <g className="fv-mascot-torso">
          <ellipse cx={46} cy={111} rx={10} ry={6.5} fill={colors.feet} />
          <ellipse cx={82} cy={111} rx={10} ry={6.5} fill={colors.feet} />
          <path d={BODY} fill={`url(#${ref("body")})`} />
          <ellipse cx={44} cy={53} rx={15} ry={8.5} transform="rotate(-30 44 53)" fill={`url(#${ref("shine")})`} />
          <ellipse cx={33} cy={92} rx={8} ry={5} fill={`url(#${ref("blush")})`} />
          <ellipse cx={95} cy={92} rx={8} ry={5} fill={`url(#${ref("blush")})`} />
          <Eyes status={status} ink={colors.ink} />
          <Mouth status={status} ink={colors.ink} />
          {error ? (
            <g className="fv-mascot-sweat">
              <path d="M101 50C103.6 54 105.6 56.6 105.6 59.2a4.6 4.6 0 0 1-9.2 0C96.4 56.6 98.4 54 101 50Z" fill="#dff4ff" />
              <circle cx={99.6} cy={58.6} r={1.2} fill="#fff" />
            </g>
          ) : null}
        </g>
        <g className="fv-mascot-spark">
          {error ? null : <circle className="fv-mascot-glow" cx={88} cy={22} r={18} fill={`url(#${ref("glow")})`} />}
          <path d={SPARKLE} fill={`url(#${ref("spark")})`} stroke={`url(#${ref("spark")})`} strokeWidth={3.4} strokeLinejoin="round" />
          {status === "success"
            ? MINI_SPARKLES.map((d) => (
                <path key={d} className="fv-mascot-mini" d={d} fill={SPARK} stroke={SPARK} strokeWidth={1.6} strokeLinejoin="round" />
              ))
            : null}
        </g>
      </g>
    </svg>
  );
}
