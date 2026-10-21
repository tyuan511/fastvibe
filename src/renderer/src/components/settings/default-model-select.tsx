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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProviderIcon } from "@/components/provider-icon";
import { SETTINGS_MODEL_TRIGGER } from "@/components/model-thinking-select";
import { providerLabel } from "@/lib/provider-label";
import type { EngineModel, FastVibeModel } from "@shared/types";

function modelKey(model: EngineModel): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Picks a provider/model with no reasoning level beside it — 轻量模型 and the memory
 * picker, both of which ask for work that deliberately does not think.
 *
 * The trigger and the menu are the ones `ModelThinkingSelect` draws in a settings pane
 * (shared `SETTINGS_MODEL_TRIGGER`, checkbox rows), because these pickers sit in the same
 * group directly under 会话模型: two shapes one row apart read as two different features.
 * "跟随…" clears the pin and hands the choice back to whatever the caller falls through to.
 */
export function DefaultModelSelect({
  models,
  value,
  onChange,
  emptyLabel,
  ariaLabel,
}: {
  models: FastVibeModel[];
  value?: EngineModel;
  onChange: (model: EngineModel | undefined) => void;
  /** Label for an unpinned value when the caller has a different fallback semantic. */
  emptyLabel?: string;
  /** Names the control for a screen reader; the row's own title is the right string. */
  ariaLabel?: string;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const groups = useMemo(() => {
    const index = new Map<string, { id: string; name: string; models: FastVibeModel[] }>();
    for (const item of models) {
      const group = index.get(item.provider);
      if (group) {
        group.models.push(item);
        continue;
      }
      index.set(item.provider, {
        id: item.provider,
        name: providerLabel(item.providerName || item.provider),
        models: [item],
      });
    }
    return [...index.values()];
  }, [models]);

  const selected = value ? modelKey(value) : undefined;
  const current = models.find((item) => selected !== undefined && modelKey(item) === selected);
  // A pinned model can disappear (provider removed, model deselected). Say so instead
  // of silently falling back, so the stale pin is visible and fixable here.
  const label = current
    ? `${providerLabel(current.providerName || current.provider)}/${current.id}`
    : value
      ? t("defaultModel.unavailable", { label: `${providerLabel(value.provider)}/${value.id}` })
      : emptyLabel ?? t("defaultModel.followLast");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={ariaLabel}
            className={SETTINGS_MODEL_TRIGGER}
          >
            <span className="min-w-0 truncate">{label}</span>
            <HugeiconsIcon strokeWidth={2} icon={ArrowDown01Icon} className="size-3 shrink-0" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuCheckboxItem
          checked={!value}
          closeOnClick
          onCheckedChange={() => {
            if (value) onChange(undefined);
          }}
        >
          {emptyLabel ?? t("defaultModel.followLast")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {models.length === 0 ? (
          // A label is Base UI's `Menu.GroupLabel`: bare, it throws
          // (`MenuGroupContext is missing`) and takes the whole app down.
          <DropdownMenuGroup>
            <DropdownMenuLabel className="font-normal text-muted-foreground">
              {t("defaultModel.empty")}
            </DropdownMenuLabel>
          </DropdownMenuGroup>
        ) : (
          groups.map((group) => (
            <DropdownMenuSub key={group.id}>
              <DropdownMenuSubTrigger>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <ProviderIcon provider={group.id} />
                  <span className="min-w-0 truncate">{group.name}</span>
                  <span className="ml-auto flex size-4 shrink-0 items-center justify-center">
                    {group.models.some((item) => modelKey(item) === selected) ? (
                      <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-4" />
                    ) : null}
                  </span>
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent align="start" side="right" className="min-w-52">
                {group.models.map((item) => (
                  <DropdownMenuCheckboxItem
                    key={modelKey(item)}
                    checked={modelKey(item) === selected}
                    closeOnClick
                    onCheckedChange={() => {
                      if (modelKey(item) !== selected) onChange({ provider: item.provider, id: item.id });
                    }}
                  >
                    <span className="truncate">{item.name || item.id}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
