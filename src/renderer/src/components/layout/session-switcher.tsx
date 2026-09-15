import { useMemo, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CommandIcon, Folder01Icon } from "@hugeicons/core-free-icons";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import type { Conversation, Project } from "@shared/types";

export function SessionSwitcher({
  open,
  conversations,
  projects,
  activeId,
  running,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  conversations: Conversation[];
  projects: Project[];
  activeId: string | null;
  running: Record<string, boolean>;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.cwd, project.name])), [projects]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return conversations.filter((item) => item.preview && (!needle || `${item.title} ${item.preview ?? ""} ${projectNames.get(item.project ?? "") ?? ""}`.toLowerCase().includes(needle)));
  }, [conversations, projectNames, query]);

  function close(): void {
    setQuery("");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setQuery(""); onOpenChange(next); }}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm"><HugeiconsIcon strokeWidth={2} icon={CommandIcon} className="size-4" />切换会话</DialogTitle>
        </DialogHeader>
        <div className="border-b border-border p-3">
          <Input autoFocus value={query} placeholder="搜索会话、项目或内容" onChange={(event) => setQuery(event.target.value)} />
        </div>
        <ScrollArea className="max-h-[min(60vh,480px)]">
          <div className="p-2">
            {filtered.length === 0 ? <p className="px-3 py-8 text-center text-xs text-muted-foreground">没有匹配的会话</p> : filtered.map((item) => (
              <button key={item.id} type="button" className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${item.id === activeId ? "bg-accent" : "hover:bg-accent/60"}`} onClick={() => { onSelect(item.id); close(); }}>
                <span className="mt-0.5 flex size-2 shrink-0 items-center justify-center">
                  {running[item.id] ? (
                    <Spinner className="size-3" />
                  ) : (
                    <span className="size-2 rounded-full bg-muted-foreground/40" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{item.title || "新会话"}</span>
                  <span className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                    {item.project ? <><HugeiconsIcon strokeWidth={2} icon={Folder01Icon} className="size-3" />{projectNames.get(item.project) ?? item.project}</> : "无项目"}
                    {item.preview ? <> · {item.preview}</> : null}
                  </span>
                </span>
                {item.id === activeId ? <span className="text-[11px] text-muted-foreground">当前</span> : null}
              </button>
            ))}
          </div>
        </ScrollArea>
        <div className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">⌘K 打开 · Esc 关闭</div>
      </DialogContent>
    </Dialog>
  );
}
