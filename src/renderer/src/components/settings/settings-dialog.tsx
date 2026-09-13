import { useEffect, useState, type JSX, type ReactNode } from "react";
import {
  ArrowLeft,
  Boxes,
  FolderOpen,
  Info,
  MessageSquare,
  RotateCcw,
  Search,
  Server,
  Settings2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { AppInfo } from "@shared/ipc";
import type { FastVibeModel, OmpSessionState, OmpStatus, ThinkingLevel } from "@shared/types";
import { useSettingsStore } from "@/stores/settings";
import { cn } from "@/lib/utils";
import { ProvidersSettings } from "./providers-settings";

const THINKING_LABELS: Record<ThinkingLevel | "auto", string> = {
  auto: "跟随模型默认",
  off: "关闭推理",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
};

const QUEUE_ITEMS = { followUp: "完成后执行", steer: "立即打断" };
const INTERRUPT_ITEMS = { immediate: "立即打断", wait: "等回合结束" };
const THINKING_ITEMS = THINKING_LABELS;

type SectionId = "general" | "chat" | "providers" | "service" | "about";

const SECTIONS: Array<{
  group: string;
  items: Array<{ id: SectionId; label: string; icon: JSX.Element }>;
}> = [
  {
    group: "个人",
    items: [
      { id: "general", label: "通用", icon: <Settings2 /> },
      { id: "chat", label: "对话", icon: <MessageSquare /> },
    ],
  },
  {
    group: "集成",
    items: [{ id: "providers", label: "供应商", icon: <Boxes /> }],
  },
  {
    group: "关于",
    items: [
      { id: "service", label: "服务", icon: <Server /> },
      { id: "about", label: "关于", icon: <Info /> },
    ],
  },
];

function Group({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-2">
      {title ? <h3 className="px-1 text-[13px] font-semibold">{title}</h3> : null}
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {children}
      </div>
    </section>
  );
}

function Row({
  title,
  description,
  control,
}: {
  title: string;
  description?: string;
  control: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="min-w-0">
        <Label className="text-[13px] font-medium">{title}</Label>
        {description ? (
          <p className="mt-0.5 text-[11.5px] leading-4 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
  status,
  session,
  models,
  project,
  onRenameSession,
  onProvidersChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: OmpStatus;
  session: OmpSessionState | null;
  models: FastVibeModel[];
  project?: string;
  onRenameSession: (id: string, title: string) => void;
  onProvidersChanged?: () => void;
}): JSX.Element | null {
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);
  const reset = useSettingsStore((state) => state.reset);
  const [section, setSection] = useState<SectionId>("general");
  const [query, setQuery] = useState("");
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    if (open && !info) {
      void window.fastvibe.app.getInfo().then(setInfo).catch(() => undefined);
    }
  }, [open, info]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const visibleSections = SECTIONS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !q || item.label.toLowerCase().includes(q)),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex bg-background">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="drag-region h-9" />
        <div className="px-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-muted-foreground"
            onClick={() => onOpenChange(false)}
          >
            <ArrowLeft className="size-4" />
            返回应用
          </Button>
          <div className="relative mt-2">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              placeholder="搜索设置"
              className="h-8 pl-8 text-xs"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-2 py-3">
          {visibleSections.map((group) => (
            <div key={group.group} className="mb-3">
              <p className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">{group.group}</p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={cn(
                      "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px]",
                      section === item.id ? "bg-sidebar-accent font-medium" : "hover:bg-sidebar-accent/50",
                    )}
                    onClick={() => setSection(item.id)}
                  >
                    <span className="text-muted-foreground [&_svg]:size-4">{item.icon}</span>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </ScrollArea>
      </aside>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl px-8 py-8">
          <h2 className="mb-6 text-[26px] font-semibold tracking-tight">
            {SECTIONS.flatMap((group) => group.items).find((item) => item.id === section)?.label}
          </h2>

          {section === "general" ? (
            <Group>
              <Row
                title="默认推理强度"
                description="模型不支持所选档位时会自动回退"
                control={
                  <Select
                    items={THINKING_ITEMS}
                    value={settings.thinkingLevel}
                    onValueChange={(value) => update({ thinkingLevel: value as typeof settings.thinkingLevel })}
                  >
                    <SelectTrigger size="sm" className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(THINKING_LABELS) as Array<keyof typeof THINKING_LABELS>).map((key) => (
                        <SelectItem key={key} value={key}>
                          {THINKING_LABELS[key]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                }
              />
              <Row
                title="发送快捷键"
                description="关闭后用 ⌘/Ctrl+Enter 发送"
                control={
                  <Switch
                    checked={settings.sendOnEnter}
                    onCheckedChange={(checked) => update({ sendOnEnter: checked })}
                  />
                }
              />
            </Group>
          ) : null}

          {section === "chat" ? (
            <Group>
              <Row
                title="流式时新消息处理"
                description="生成过程中发送消息的默认行为"
                control={
                  <Select
                    items={QUEUE_ITEMS}
                    value={settings.queueBehavior}
                    onValueChange={(value) => update({ queueBehavior: value as typeof settings.queueBehavior })}
                  >
                    <SelectTrigger size="sm" className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="followUp">完成后执行</SelectItem>
                      <SelectItem value="steer">立即打断</SelectItem>
                    </SelectContent>
                  </Select>
                }
              />
              <Row
                title="自动压缩"
                description="上下文接近上限时自动压缩"
                control={
                  <Switch
                    checked={settings.autoCompact}
                    onCheckedChange={(checked) => update({ autoCompact: checked })}
                  />
                }
              />
              <Row
                title="打断方式"
                description="默认打断时是否等当前回合结束"
                control={
                  <Select
                    items={INTERRUPT_ITEMS}
                    value={settings.interruptMode}
                    onValueChange={(value) => update({ interruptMode: value as typeof settings.interruptMode })}
                  >
                    <SelectTrigger size="sm" className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="immediate">立即打断</SelectItem>
                      <SelectItem value="wait">等回合结束</SelectItem>
                    </SelectContent>
                  </Select>
                }
              />
              <Row
                title="显示思考过程"
                control={
                  <Switch
                    checked={settings.showThinking}
                    onCheckedChange={(checked) => update({ showThinking: checked })}
                  />
                }
              />
              <Row
                title="显示消息时间"
                control={
                  <Switch
                    checked={settings.showTimestamps}
                    onCheckedChange={(checked) => update({ showTimestamps: checked })}
                  />
                }
              />
            </Group>
          ) : null}

          {section === "providers" ? <ProvidersSettings onChanged={() => onProvidersChanged?.()} /> : null}

          {section === "service" ? (
            <div className="space-y-6">
              <Group title="运行状态">
                <Row
                  title="引擎状态"
                  control={
                    <Badge variant={status.state === "ready" ? "secondary" : "outline"}>
                      {status.state === "ready" ? "运行中" : status.state}
                    </Badge>
                  }
                />
                <Row
                  title="当前模型"
                  control={
                    <span className="text-[12.5px]">
                      {session?.model ? `${session.model.provider}/${session.model.id}` : "—"}
                    </span>
                  }
                />
                <Row
                  title="工作区"
                  control={
                    <span className="max-w-80 truncate text-[12.5px]">
                      {project ?? "无项目（临时目录）"}
                    </span>
                  }
                />
                <Row title="可用模型" control={<span className="text-[12.5px]">{models.length}</span>} />
                <Row
                  title="会话名称"
                  description={session?.sessionName ?? "未命名"}
                  control={
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!session?.sessionId}
                      onClick={() => {
                        const name = window.prompt("会话名称", session?.sessionName ?? "");
                        if (name?.trim() && session?.sessionId) onRenameSession(session.sessionId, name.trim());
                      }}
                    >
                      重命名
                    </Button>
                  }
                />
              </Group>
              {info ? (
                <Group title="数据">
                  <Row
                    title="运行数据目录"
                    description={info.runtimeRoot}
                    control={
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => void window.fastvibe.workspace.reveal(info.runtimeRoot)}
                      >
                        <FolderOpen />
                        打开
                      </Button>
                    }
                  />
                </Group>
              ) : null}
            </div>
          ) : null}

          {section === "about" ? (
            <div className="space-y-6">
              <Group title="模型元数据">
                <Row
                  title="models.dev 快照"
                  description={
                    info?.modelsDev?.generatedAt
                      ? `生成于 ${new Date(info.modelsDev.generatedAt).toLocaleDateString()} · ${info.modelsDev.models} 个模型 / ${info.modelsDev.aliases} 条索引`
                      : "未内置快照，将使用默认值"
                  }
                  control={
                    <Badge variant={info?.modelsDev?.models ? "secondary" : "destructive"}>
                      {info?.modelsDev?.models ? "已内置" : "缺失"}
                    </Badge>
                  }
                />
              </Group>
              <Group title="版本">
                <Row title="FastVibe" control={<span className="text-[12.5px]">{info?.version ?? "—"}</span>} />
                <Row title="平台" control={<span className="text-[12.5px]">{info?.platform ?? "—"}</span>} />
                <Row
                  title="数据目录"
                  description={info?.userData ?? "—"}
                  control={
                    info ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => void window.fastvibe.workspace.reveal(info.userData)}
                      >
                        <FolderOpen />
                        打开
                      </Button>
                    ) : null
                  }
                />
              </Group>
              <Button variant="outline" size="sm" onClick={reset}>
                <RotateCcw />
                恢复默认设置
              </Button>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
