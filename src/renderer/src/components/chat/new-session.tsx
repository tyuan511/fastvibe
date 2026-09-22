import { type JSX } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { HugeiconsIcon } from "@hugeicons/react";
import { Bug01Icon, Compass01Icon, MagicWand02Icon, ShieldCheckIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";

/**
 * Task templates offered under the composer on a fresh conversation. Kept here
 * (rather than inside MessageList) so the same list feeds the hero and the chip
 * row that sits below the input box.
 */
export function newSessionSuggestions(): Array<{ icon: JSX.Element; label: string; prompt: string }> {
  return [
    {
      icon: <HugeiconsIcon strokeWidth={2} icon={Compass01Icon} />,
      label: i18n.t("chat:newSession.explore") as string,
      prompt: i18n.t("chat:newSession.explorePrompt") as string,
    },
    {
      icon: <HugeiconsIcon strokeWidth={2} icon={MagicWand02Icon} />,
      label: i18n.t("chat:newSession.build") as string,
      prompt: i18n.t("chat:newSession.buildPrompt") as string,
    },
    {
      icon: <HugeiconsIcon strokeWidth={2} icon={ShieldCheckIcon} />,
      label: i18n.t("chat:newSession.review") as string,
      prompt: i18n.t("chat:newSession.reviewPrompt") as string,
    },
    {
      icon: <HugeiconsIcon strokeWidth={2} icon={Bug01Icon} />,
      label: i18n.t("chat:newSession.fix") as string,
      prompt: i18n.t("chat:newSession.fixPrompt") as string,
    },
  ];
}

/** Warm, time-aware greeting. Pure so it stays easy to reason about and reuse. */
export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 11) return i18n.t("chat:newSession.morning") as string;
  if (hour >= 11 && hour < 13) return i18n.t("chat:newSession.noon") as string;
  if (hour >= 13 && hour < 18) return i18n.t("chat:newSession.afternoon") as string;
  if (hour >= 18 && hour < 23) return i18n.t("chat:newSession.evening") as string;
  return i18n.t("chat:newSession.night") as string;
}

/** Greeting shown above the composer on a brand-new conversation. */
export function NewSessionHero(): JSX.Element {
  useTranslation("chat");
  return (
    <div className="flex flex-col items-center">
      <h2 className="text-2xl font-semibold tracking-tight">
        {greetingForHour(new Date().getHours())}
      </h2>
    </div>
  );
}

/** Compact suggestion pills, rendered under the composer like the reference. */
export function SuggestionChips({ onSelect }: { onSelect: (prompt: string) => void }): JSX.Element {
  useTranslation("chat");
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 px-6">
      {newSessionSuggestions().map((item) => (
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
