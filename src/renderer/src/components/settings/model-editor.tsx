import { useState, type JSX } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { ProviderModel, ThinkingLevel } from "@shared/types";

const ALL_INPUTS = ["text", "image", "video", "file"] as const;
const INPUT_LABELS: Record<string, string> = {
  text: "文本",
  image: "图片",
  video: "视频",
  file: "文件",
};
const EFFORTS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function ModelEditor({
  model,
  open,
  onOpenChange,
  onSave,
}: {
  model: ProviderModel | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (model: ProviderModel) => void;
}): JSX.Element | null {
  const [draft, setDraft] = useState<ProviderModel | null>(model);
  const [initialId, setInitialId] = useState<string | null>(model?.id ?? null);

  // Sync when a different model is opened.
  if (model && model.id !== initialId) {
    setDraft(model);
    setInitialId(model.id);
  }
  if (!draft) return null;

  function patch(next: Partial<ProviderModel>): void {
    setDraft((current) => (current ? { ...current, ...next } : current));
  }

  function toggleInput(value: string): void {
    if (!draft) return;
    const has = draft.input.includes(value);
    patch({ input: has ? draft.input.filter((item) => item !== value) : [...draft.input, value] });
  }

  function toggleEffort(level: ThinkingLevel): void {
    if (!draft) return;
    const current = draft.thinkingLevels ?? [];
    const has = current.includes(level);
    const next = has ? current.filter((item) => item !== level) : [...current, level];
    patch({ thinkingLevels: EFFORTS.filter((item) => next.includes(item)) });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate">编辑模型 · {draft.name || draft.id}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">上下文长度</Label>
              <Input
                type="number"
                value={draft.contextWindow}
                onChange={(event) => patch({ contextWindow: Number(event.target.value) || 0 })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">最大输出</Label>
              <Input
                type="number"
                value={draft.maxTokens}
                onChange={(event) => patch({ maxTokens: Number(event.target.value) || 0 })}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">输入类型</Label>
            <div className="flex flex-wrap gap-3">
              {ALL_INPUTS.map((value) => (
                <label key={value} className="flex items-center gap-1.5 text-[12.5px]">
                  <Checkbox
                    checked={draft.input.includes(value)}
                    onCheckedChange={() => toggleInput(value)}
                  />
                  {INPUT_LABELS[value]}
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-xs">支持推理</Label>
              <p className="text-[11px] text-muted-foreground">关闭后模型不显示推理强度选择</p>
            </div>
            <Switch checked={draft.reasoning} onCheckedChange={(checked) => patch({ reasoning: checked })} />
          </div>

          {draft.reasoning ? (
            <div className="space-y-1.5">
              <Label className="text-xs">推理强度档位</Label>
              <div className="flex flex-wrap gap-3">
                {EFFORTS.map((level) => (
                  <label key={level} className="flex items-center gap-1.5 text-[12.5px]">
                    <Checkbox
                      checked={(draft.thinkingLevels ?? []).includes(level)}
                      onCheckedChange={() => toggleEffort(level)}
                    />
                    {level}
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() => {
              onSave({ ...draft, source: "manual" });
              onOpenChange(false);
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
