import { useId, useState, type CSSProperties, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Slider } from "@/components/ui/slider";
import { thinkingLabel, thinkingMenuLabel } from "@/lib/thinking-levels";
import type { ThinkingLevel } from "@shared/types";
import "./thinking-effort-slider.css";

type Effort = ThinkingLevel | "auto";

export function ThinkingEffortSlider({
  options,
  value,
  disabled,
  onCommit,
}: {
  options: readonly Effort[];
  value: Effort;
  disabled: boolean;
  onCommit: (level: Effort) => void;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const labelId = useId();
  const [position, setPosition] = useState(Math.max(0, options.indexOf(value)));
  const [previousValue, setPreviousValue] = useState(value);
  if (previousValue !== value) {
    setPreviousValue(value);
    setPosition(Math.max(0, options.indexOf(value)));
  }
  const index = Math.min(options.length - 1, Math.max(0, Math.round(position)));
  const preview = options[index] ?? value;
  const atMax = options.length > 1 && index === options.length - 1 && preview !== "auto";
  const label = preview === "auto" ? thinkingMenuLabel("auto") : thinkingLabel(preview);

  function commit(next: number): void {
    const nextIndex = Math.min(options.length - 1, Math.max(0, Math.round(next)));
    setPosition(nextIndex);
    const level = options[nextIndex];
    if (level && level !== value) onCommit(level);
  }

  return (
    <div
      className="thinking-effort px-2.5 pt-2 pb-1"
      data-max={atMax || undefined}
      data-disabled={disabled || options.length < 2 || undefined}
      onKeyDownCapture={(event) => {
        if (disabled || options.length < 2 || event.altKey || event.ctrlKey || event.metaKey) return;
        let next: number;
        switch (event.key) {
          case "ArrowLeft":
          case "ArrowDown":
          case "PageDown": next = index - 1; break;
          case "ArrowRight":
          case "ArrowUp":
          case "PageUp": next = index + 1; break;
          case "Home": next = 0; break;
          case "End": next = options.length - 1; break;
          default: return;
        }
        event.preventDefault();
        event.stopPropagation();
        commit(next);
      }}
    >
      <div id={labelId} className="flex items-baseline gap-2 text-sm">
        <span className="text-muted-foreground">{t("composer.thinking")}</span>
        <span key={preview} className="thinking-effort-label font-medium text-primary">{label}</span>
      </div>
      <div className="relative mt-1">
        <Slider
          className="thinking-effort-slider"
          aria-labelledby={labelId}
          min={0}
          max={Math.max(1, options.length - 1)}
          step={0.001}
          largeStep={1}
          value={[position]}
          disabled={disabled || options.length < 2}
          onValueChange={(next) => {
            setPosition(Array.isArray(next) ? next[0] : next);
          }}
          onValueCommitted={(next) => {
            commit(Array.isArray(next) ? next[0] : next);
          }}
        />
        <div aria-hidden="true" className="thinking-effort-ticks pointer-events-none absolute inset-y-0 flex items-center justify-between">
          {options.map((level, tick) => (
            <span key={level} data-filled={tick <= index && preview !== "auto" || undefined} />
          ))}
        </div>
        {atMax && !disabled ? (
          <div
            aria-hidden="true"
            className="thinking-effort-particles pointer-events-none absolute inset-x-0 overflow-hidden rounded-full"
            style={{ clipPath: `inset(0 calc(${1 - position / (options.length - 1)} * (100% - var(--thinking-thumb-size)) + var(--thinking-thumb-size) / 2) 0 0)` }}
          >
            {Array.from({ length: 30 }, (_, particle) => (
              <i key={particle} style={{
                "--particle-x": `${(particle * 37 + 7) % 94}%`,
                "--particle-y": `${(particle * 29 + 17) % 76 + 8}%`,
                "--particle-delay": `${particle * -0.47}s`,
                "--particle-duration": `${1.8 + particle % 4 * 0.35}s`,
                "--particle-size": `${1.5 + particle % 3 * 0.75}px`,
              } as CSSProperties} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
