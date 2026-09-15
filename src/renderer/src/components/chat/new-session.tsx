import { type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Bug01Icon, Compass01Icon, MagicWand02Icon, ShieldCheckIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { F_MARK_FILL } from "@/lib/f-mark";

/**
 * Task templates offered under the composer on a fresh conversation. Kept here
 * (rather than inside MessageList) so the same list feeds the hero and the chip
 * row that sits below the input box.
 */
export const NEW_SESSION_SUGGESTIONS: Array<{ icon: JSX.Element; label: string; prompt: string }> = [
  {
    icon: <HugeiconsIcon strokeWidth={2} icon={Compass01Icon} />,
    label: "探索代码",
    prompt: "请探索这个项目，说明它的结构、主要模块和它们之间的关系。",
  },
  {
    icon: <HugeiconsIcon strokeWidth={2} icon={MagicWand02Icon} />,
    label: "构建功能",
    prompt: "帮我构建一个新功能：",
  },
  {
    icon: <HugeiconsIcon strokeWidth={2} icon={ShieldCheckIcon} />,
    label: "审查代码",
    prompt: "请审查最近的代码改动，指出问题和改进建议。",
  },
  {
    icon: <HugeiconsIcon strokeWidth={2} icon={Bug01Icon} />,
    label: "修复问题",
    prompt: "帮我定位并修复这个问题：",
  },
];

/** Warm, time-aware greeting. Pure so it stays easy to reason about and reuse. */
export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 11) return "早上好呀，新的一天开始啦";
  if (hour >= 11 && hour < 13) return "中午好呀，记得好好吃饭";
  if (hour >= 13 && hour < 18) return "下午好呀，继续加油";
  if (hour >= 18 && hour < 23) return "晚上好呀，今天辛苦啦";
  return "夜深啦，早点休息呀";
}

/**
 * Faint brand watermark. The outline F is an evenodd filled path (the “stroke”
 * is the filled region), tinted with the theme foreground so it stays subtle
 * in both light and dark.
 */
function FWatermark(): JSX.Element {
  return (
    <div className="pointer-events-none absolute bottom-full left-1/2 h-[28rem] w-[28rem] -translate-x-1/2 overflow-hidden">
    <svg
      viewBox="0 0 1095 1095"
      aria-hidden="true"
      className="absolute left-0 top-0 size-[28rem] translate-y-1/2 text-foreground opacity-[0.10] dark:opacity-[0.12] [mask-image:linear-gradient(to_bottom,black_0%,black_22%,transparent_50%)] [-webkit-mask-image:linear-gradient(to_bottom,black_0%,black_22%,transparent_50%)]"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d={F_MARK_FILL}
      />
    </svg>
    </div>
  );
}

/** Watermark + greeting, shown above the composer on a brand-new conversation. */
export function NewSessionHero(): JSX.Element {
  return (
    <div className="relative flex flex-col items-center">
      <FWatermark />
      <h2 className="relative z-10 text-[26px] font-semibold tracking-tight">
        {greetingForHour(new Date().getHours())}
      </h2>
    </div>
  );
}

/** Compact suggestion pills, rendered under the composer like the reference. */
export function SuggestionChips({ onSelect }: { onSelect: (prompt: string) => void }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 px-6">
      {NEW_SESSION_SUGGESTIONS.map((item) => (
        <Button
          key={item.label}
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 font-normal"
          onClick={() => onSelect(item.prompt)}
        >
          <span className="text-muted-foreground">{item.icon}</span>
          {item.label}
        </Button>
      ))}
    </div>
  );
}
