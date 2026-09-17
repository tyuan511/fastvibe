import { useMemo, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
  DropdownMenu,
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
import { Button } from "@/components/ui/button";
import { providerLabel } from "@/lib/provider-label";
import type { EngineModel, FastVibeModel } from "@shared/types";

function modelKey(model: EngineModel): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Picks the provider/model a new conversation starts on.
 *
 * Mirrors the composer's model menu (provider submenus) so the two read the same,
 * and never shows the internal `custom-` provider namespace. "跟随上次使用" clears
 * the pin and hands the choice back to the engine.
 */
export function DefaultModelSelect({
  models,
  value,
  onChange,
}: {
  models: FastVibeModel[];
  value?: EngineModel;
  onChange: (model: EngineModel | undefined) => void;
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
      : t("defaultModel.followLast");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" className="w-44 justify-between gap-1.5 font-normal">
            <span className="truncate">{label}</span>
            <HugeiconsIcon strokeWidth={2} icon={ArrowDown01Icon} className="size-3.5 shrink-0" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onClick={() => onChange(undefined)}>
          <span className="min-w-0 flex-1 truncate">{t("defaultModel.followLast")}</span>
          <span className="ml-auto flex size-4 shrink-0 items-center justify-center">
            {value ? null : <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-4" />}
          </span>
        </DropdownMenuItem>
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
                <span className="flex min-w-0 flex-1 items-center">
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
                  <DropdownMenuItem
                    key={modelKey(item)}
                    onClick={() => onChange({ provider: item.provider, id: item.id })}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.name || item.id}</span>
                    <span className="ml-auto flex size-4 shrink-0 items-center justify-center">
                      {modelKey(item) === selected ? (
                        <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-4" />
                      ) : null}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
