import { useMemo, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProviderIcon } from "@/components/provider-icon";
import { thinkingLabel } from "@/lib/thinking-levels";
import { cn } from "@/lib/utils";
import {
  DEFAULT_THINKING_LEVELS,
  THINKING_LEVELS,
  type EngineModel,
  type FastVibeModel,
  type ThinkingLevel,
} from "@shared/types";

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function providerLabel(model: FastVibeModel): string {
  return model.providerName || model.provider.replace(/^custom-/, "");
}

export function ModelThinkingSelect({
  models,
  model,
  thinkingLevel,
  fallbackThinkingLevels = DEFAULT_THINKING_LEVELS,
  emptyModelLabel,
  inheritModelLabel,
  manageModelsLabel,
  onManageModels,
  onModelChange,
  onThinkingChange,
  readOnly = false,
  disabled = false,
  surface = "composer",
  className,
  ariaLabel,
}: {
  models: FastVibeModel[];
  model?: EngineModel;
  thinkingLevel?: ThinkingLevel | string;
  fallbackThinkingLevels?: ThinkingLevel[];
  emptyModelLabel?: string;
  inheritModelLabel?: string;
  manageModelsLabel?: string;
  onManageModels?: () => void;
  onModelChange: (model: EngineModel | undefined) => void;
  onThinkingChange: (level: ThinkingLevel) => void;
  readOnly?: boolean;
  disabled?: boolean;
  surface?: "composer" | "settings";
  className?: string;
  ariaLabel?: string;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const selected = model ? modelKey(model) : undefined;
  const selectedModel = models.find((item) => modelKey(item) === selected);
  const thinkingOptions = selectedModel?.thinkingLevels?.length
    ? selectedModel.thinkingLevels
    : fallbackThinkingLevels;
  const thinkingValue = (THINKING_LEVELS as readonly string[]).includes(thinkingLevel ?? "")
    ? thinkingLevel as ThinkingLevel
    : undefined;
  const selectedThinking = thinkingValue ?? thinkingOptions[0] ?? "medium";
  const currentThinkingLabel = thinkingLabel(selectedThinking);
  const currentModelLabel = selectedModel
    ? `${providerLabel(selectedModel)}/${selectedModel.id}`
    : model
      ? `${model.provider}/${model.id}`
      : readOnly
        ? t("composer.noModels")
        : inheritModelLabel ?? emptyModelLabel ?? (models.length === 0 ? t("composer.addModel") : t("composer.pickModel"));
  const groups = useMemo(() => {
    const result: { id: string; name: string; models: FastVibeModel[] }[] = [];
    const index = new Map<string, number>();
    for (const item of models) {
      const existing = index.get(item.provider);
      if (existing === undefined) {
        index.set(item.provider, result.length);
        result.push({ id: item.provider, name: providerLabel(item), models: [item] });
      } else {
        result[existing].models.push(item);
      }
    }
    return result;
  }, [models]);

  const label = (
    <>
      <span className="min-w-0 truncate">{currentModelLabel}</span>
      <span className={cn("shrink-0 text-border", !readOnly && surface === "composer" && "hidden @min-[27.5rem]/composer:inline")}>·</span>
      <span className={cn("shrink-0", !readOnly && surface === "composer" && "hidden @min-[27.5rem]/composer:inline")}>{currentThinkingLabel}</span>
    </>
  );

  if (readOnly) {
    return (
      <span className={cn("inline-flex h-7 max-w-40 min-w-0 shrink items-center gap-1 rounded-full px-2 text-sm text-muted-foreground @min-[22rem]/composer:max-w-80", className)}>
        {label}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button
            variant={surface === "settings" ? "outline" : "ghost"}
            size="sm"
            aria-label={ariaLabel}
            className={cn(
              "min-w-0 justify-between gap-1 font-normal text-muted-foreground",
              surface === "settings"
                ? "h-auto min-h-9 w-64 max-w-full rounded-lg py-2"
                : "h-7 max-w-40 shrink rounded-full px-2 @min-[22rem]/composer:max-w-80",
              className,
            )}
          >
            {label}
            <HugeiconsIcon strokeWidth={2} icon={ArrowDown01Icon} className="size-3 shrink-0" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-52">
        {inheritModelLabel ? (
          <>
            <DropdownMenuCheckboxItem
              checked={!model}
              disabled={disabled}
              closeOnClick
              onCheckedChange={() => {
                if (model) onModelChange(undefined);
              }}
            >
              {inheritModelLabel}
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {models.length === 0 ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="font-normal text-muted-foreground">{t("composer.noModels")}</DropdownMenuLabel>
          </DropdownMenuGroup>
        ) : (
          groups.map((group) => {
            const selectedInGroup = group.models.some((item) => modelKey(item) === selected);
            return (
              <DropdownMenuSub key={group.id}>
                <DropdownMenuSubTrigger disabled={disabled}>
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <ProviderIcon provider={group.id} />
                    <span className="min-w-0 truncate">{group.name}</span>
                    <span className="ml-auto flex size-4 shrink-0 items-center justify-center">
                      {selectedInGroup ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" /> : null}
                    </span>
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent align="start" side="right" className="min-w-52">
                  {group.models.map((item) => (
                    <DropdownMenuCheckboxItem
                      key={modelKey(item)}
                      checked={modelKey(item) === selected}
                      disabled={disabled}
                      closeOnClick
                      onCheckedChange={() => {
                        if (modelKey(item) !== selected) onModelChange({ provider: item.provider, id: item.id });
                      }}
                    >
                      <span className="truncate">{item.name || item.id}</span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            );
          })
        )}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={disabled}>
            <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
              <span>{t("composer.thinking")}</span>
              <span className="text-xs text-muted-foreground">{currentThinkingLabel}</span>
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent align="start" side="right" className="min-w-36">
            {thinkingOptions.map((level) => (
              <DropdownMenuCheckboxItem
                key={level}
                checked={level === selectedThinking}
                disabled={disabled}
                closeOnClick
                onCheckedChange={() => {
                  if (level !== selectedThinking) onThinkingChange(level);
                }}
              >
                {thinkingLabel(level)}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {onManageModels ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={disabled} onClick={onManageModels}>{manageModelsLabel ?? t("composer.manageModels")}</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
