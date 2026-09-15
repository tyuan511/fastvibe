import { useEffect, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Layers01Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { providerLabel } from "@/lib/provider-label";
import type { FastVibeModel, MultiRunRequest, Project } from "@shared/types";

export function MultiRunDialog({ open, projects, models, defaultProject, onOpenChange, onLaunch }: {
  open: boolean;
  projects: Project[];
  models: FastVibeModel[];
  defaultProject?: string;
  onOpenChange: (open: boolean) => void;
  onLaunch: (request: MultiRunRequest) => Promise<void>;
}): JSX.Element {
  const [project, setProject] = useState(defaultProject ?? "");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [launching, setLaunching] = useState(false);
  const [isolate, setIsolate] = useState(true);

  useEffect(() => {
    if (!open) return;
    setProject(defaultProject ?? projects[0]?.cwd ?? "");
    setIsolate(Boolean(defaultProject ?? projects[0]?.cwd));
    setSelected((current) => current.filter((key) => models.some((model) => `${model.provider}/${model.id}` === key)));
  }, [defaultProject, models, open, projects]);

  function toggle(model: FastVibeModel): void {
    const key = `${model.provider}/${model.id}`;
    setSelected((current) => current.includes(key) ? current.filter((item) => item !== key) : current.length < 5 ? [...current, key] : current);
  }

  async function launch(): Promise<void> {
    if (!prompt.trim() || selected.length === 0 || launching) return;
    setLaunching(true);
    try {
      await onLaunch({ project: project || undefined, name: name.trim() || undefined, prompt: prompt.trim(), isolate: isolate && Boolean(project), models: selected.map((key) => { const [provider, ...rest] = key.split("/"); return { provider, modelId: rest.join("/") }; }) });
      setPrompt("");
      setName("");
      onOpenChange(false);
    } finally {
      setLaunching(false);
    }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
      <DialogHeader className="border-b border-border px-4 py-3"><DialogTitle className="flex items-center gap-2 text-sm"><HugeiconsIcon strokeWidth={2} icon={Layers01Icon} className="size-4" />并行运行</DialogTitle></DialogHeader>
      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>项目</Label><select value={project} onChange={(event) => setProject(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="">无项目</option>{projects.map((item) => <option key={item.cwd} value={item.cwd}>{item.name}</option>)}</select></div>
          <div className="space-y-1.5"><Label>运行组名称（可选）</Label><Input value={name} placeholder="例如 API 重构方案" onChange={(event) => setName(event.target.value)} /></div>
        </div>
        <div className="space-y-1.5"><Label>提示词</Label><Textarea value={prompt} placeholder="同一个任务交给多个模型并行处理" className="min-h-24 resize-y" onChange={(event) => setPrompt(event.target.value)} /></div>
        <div className="space-y-2"><div className="flex items-center justify-between"><Label>模型（最多 5 个）</Label><span className="text-[11px] text-muted-foreground">已选 {selected.length}/5</span></div><ScrollArea className="max-h-44 rounded-md border border-border"><div className="grid gap-1 p-2 sm:grid-cols-2">{models.map((model) => { const key = `${model.provider}/${model.id}`; return <label key={key} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs hover:bg-accent/60"><Checkbox checked={selected.includes(key)} onCheckedChange={() => toggle(model)} /><span className="min-w-0 truncate"><span className="block truncate font-medium">{model.name || model.id}</span><span className="block truncate text-[10px] text-muted-foreground">{providerLabel(model.providerName || model.provider)}/{model.id}</span></span></label>; })}</div></ScrollArea></div>
        <label className="flex items-start gap-2 rounded-md border border-border/70 px-3 py-2 text-xs"><Checkbox checked={isolate} disabled={!project} onCheckedChange={(checked) => setIsolate(checked === true)} /><span><span className="block font-medium">为每个运行创建独立 worktree</span><span className="text-[11px] text-muted-foreground">仅 Git 项目可用，避免并行模型修改同一目录。</span></span></label>
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button disabled={!prompt.trim() || selected.length === 0 || launching} onClick={() => void launch()}><HugeiconsIcon strokeWidth={2} icon={PlayIcon} className="size-3.5" />{launching ? "启动中…" : "启动并行运行"}</Button></div>
      </div>
    </DialogContent>
  </Dialog>;
}
