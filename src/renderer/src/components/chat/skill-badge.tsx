import { type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, MagicWand02Icon } from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { skillDescription } from "@/lib/skill-descriptions";
import type { ChatMessage } from "@shared/types";

/** What a row carries when its prompt forced a skill. */
export type SkillMark = NonNullable<ChatMessage["skill"]>;

/**
 * The skill a prompt was sent with, as one quiet pill.
 *
 * `/skill:office` makes the engine paste the whole `SKILL.md` into the message, which is
 * what the *model* reads — 3 KB to 40 KB of instructions nobody typed. The thread therefore
 * keeps the person's own words in the bubble and says which skill came along beside it, in
 * the same glyph and tint the composer's `/` palette and 插件 page use for skills, so the
 * three read as one thing.
 *
 * It states what it is rather than only icon-and-name, because a tooltip never arrives on a
 * touchscreen: the label has to carry the meaning on its own.
 */
export function SkillBadge({ skill, className, onRemove }: {
  skill: SkillMark;
  className?: string;
  onRemove?: () => void;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const hint = skillDescription(skill.name) ?? skill.location;
  const badge = (
    <Badge
      variant="outline"
      className={cn(
        "max-w-72 gap-1 border-transparent bg-warning/10 py-0.5 text-warning ring-1 ring-warning/15",
        className,
      )}
    >
      <HugeiconsIcon strokeWidth={2} icon={MagicWand02Icon} className="size-3 shrink-0" />
      <span className="shrink-0 font-normal opacity-80">{t("message.skill")}</span>
      <span className="min-w-0 truncate font-medium">{skill.name}</span>
      {onRemove ? (
        <button
          type="button"
          className="flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-warning/20"
          aria-label={t("attach.remove", { name: skill.name })}
          onClick={onRemove}
        >
          <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} className="size-3" />
        </button>
      ) : null}
    </Badge>
  );

  if (!hint) return badge;
  return (
    <Tooltip>
      <TooltipTrigger render={badge} />
      <TooltipContent side="top" align="end" className="items-start">
        <span className="whitespace-pre-wrap break-words">{hint}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/** The badge row above a user bubble, matching where attachment chips sit. */
export function SkillBadgeRow({ skill }: { skill: SkillMark }): JSX.Element {
  return (
    <div className="flex justify-end">
      <SkillBadge skill={skill} />
    </div>
  );
}
