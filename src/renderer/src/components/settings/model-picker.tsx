import { useMemo, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading03Icon, Search01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ProviderModel } from "@shared/types";

const SOURCE_LABEL: Record<string, string> = {
  "models.dev": "models.dev",
  native: "内置",
  default: "默认参数",
};

export function inputSummary(model: ProviderModel): string {
  const parts: string[] = [];
  if (model.input.includes("text")) parts.push("文本");
  if (model.input.includes("image")) parts.push("图片");
  if (model.input.includes("video")) parts.push("视频");
  if (model.input.includes("file")) parts.push("文件");
  return parts.join(" / ") || "文本";
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
            placeholder="搜索模型"
            className="h-8 pl-8 text-xs"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button size="xs" variant="outline" onClick={() => onSelectedChange(new Set(filtered.map((m) => m.id)))}>
          全选
        </Button>
        <Button size="xs" variant="outline" onClick={() => onSelectedChange(new Set())}>
          清空
        </Button>
        <span className="shrink-0 text-xs text-muted-foreground">
          已选 {selected.size}/{models.length}
        </span>
      </div>
      <ScrollArea className="h-72 rounded-lg border border-border">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-4 animate-spin" />
            正在拉取模型列表…
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">没有匹配的模型</p>
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
                    {model.reasoning ? <Badge variant="secondary">推理</Badge> : null}
                    <span>{inputSummary(model)}</span>
                    <span>{Math.round(model.contextWindow / 1000)}K</span>
                    {model.source ? <span>· {SOURCE_LABEL[model.source] ?? model.source}</span> : null}
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
