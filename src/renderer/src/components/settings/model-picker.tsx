import { useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading03Icon, Search01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ProviderModel } from "@shared/types";

function sourceLabel(source: string): string {
  if (source === "native") return i18n.t("settings:modelPicker.native") as string;
  if (source === "default") return i18n.t("settings:modelPicker.defaultParams") as string;
  return source;
}

export function inputSummary(model: ProviderModel): string {
  const parts: string[] = [];
  if (model.input.includes("text")) parts.push(i18n.t("settings:modelPicker.text") as string);
  if (model.input.includes("image")) parts.push(i18n.t("settings:modelPicker.image") as string);
  if (model.input.includes("video")) parts.push(i18n.t("settings:modelPicker.video") as string);
  if (model.input.includes("file")) parts.push(i18n.t("settings:modelPicker.file") as string);
  return parts.join(" / ") || (i18n.t("settings:modelPicker.text") as string);
}

export function ModelPicker({
  models,
  selected,
  onSelectedChange,
  loading,
}: {
  models: ProviderModel[];
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  loading?: boolean;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(q));
  }, [models, query]);

  function toggle(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <HugeiconsIcon strokeWidth={2} icon={Search01Icon} className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            placeholder={t("modelPicker.search")}
            className="h-8 pl-8 text-xs"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button size="xs" variant="outline" onClick={() => onSelectedChange(new Set(filtered.map((m) => m.id)))}>
          {t("modelPicker.selectAll")}
        </Button>
        <Button size="xs" variant="outline" onClick={() => onSelectedChange(new Set())}>
          {t("modelPicker.clear")}
        </Button>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t("modelPicker.selected", { selected: selected.size, total: models.length })}
        </span>
      </div>
      <ScrollArea className="h-72 rounded-lg border border-border">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-4 animate-spin" />
            {t("modelPicker.loading")}
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">{t("modelPicker.none")}</p>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((model) => {
              const checked = selected.has(model.id);
              return (
                <button
                  key={model.id}
                  type="button"
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-muted/50"
                  onClick={() => toggle(model.id)}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                      checked ? "border-primary bg-primary text-primary-foreground" : "border-input",
                    )}
                  >
                    {checked ? <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-3" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{model.name || model.id}</span>
                    <span className="block truncate text-xs text-muted-foreground">{model.id}</span>
                  </span>
                  <span className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:flex">
                    {model.reasoning ? <Badge variant="secondary">{t("modelPicker.reasoning")}</Badge> : null}
                    <span>{inputSummary(model)}</span>
                    <span>{Math.round(model.contextWindow / 1000)}K</span>
                    {model.source ? <span>· {sourceLabel(model.source)}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
