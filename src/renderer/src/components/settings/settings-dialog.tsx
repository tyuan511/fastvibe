import { useEffect, useState, type JSX, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { Analytics01Icon, Archive04Icon, ArrowLeft01Icon, BoxesIcon, Folder01Icon, InformationCircleIcon, KeyboardIcon, Plug01Icon, PuzzleIcon, RotateCcwIcon, Settings02Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import type { EngineModel, FastVibeModel, PermissionMode } from "@shared/types";
import { useSettingsStore } from "@/stores/settings";
import { PERMISSION_DESCRIPTIONS, PERMISSION_MODE_ITEMS, PERMISSION_MODES } from "@/lib/permission-modes";
import type { ThemeMode } from "@/lib/themes";
import { UI_FONT_SIZE_MAX, UI_FONT_SIZE_MIN, UI_FONT_SIZE_STEP } from "@/lib/themes";
import { readSidebarWidth } from "@/lib/sidebar-width";
import { cn } from "@/lib/utils";
import { ProvidersSettings } from "./providers-settings";
import { ArchivedSettings, type DeleteConversationsResult } from "./archived-settings";
import { DefaultModelSelect } from "./default-model-select";
import { ExtensionsSettings } from "./extensions-settings";
import { McpSettings } from "./mcp-settings";
import { SkillsSettings } from "./skills-settings";
import { THINKING_MENU_LABELS } from "@/lib/thinking-levels";
import { ThemeSelect } from "./theme-select";
import { UsageSettings } from "./usage-settings";
import { ShortcutsSettings } from "./shortcuts-settings";
import { AboutUpdate } from "./about-update";

const QUEUE_ITEMS = { followUp: "完成后执行", steer: "立即打断" };
const INTERRUPT_ITEMS = { immediate: "立即打断", wait: "等回合结束" };
const THINKING_ITEMS = THINKING_MENU_LABELS;
const THEME_MODE_ITEMS = { system: "跟随系统", light: "亮色", dark: "暗色" };

const UI_FONT_SIZE_ITEMS: Record<string, string> = {};
function uiFontSizeValues(): number[] {
  const values: number[] = [];
  for (let size = UI_FONT_SIZE_MIN; size <= UI_FONT_SIZE_MAX; size += UI_FONT_SIZE_STEP) values.push(size);
  return values;
}
for (const size of uiFontSizeValues()) UI_FONT_SIZE_ITEMS[String(size)] = `${size}px`;

export type SectionId = "general" | "shortcuts" | "archived" | "usage" | "providers" | "mcp" | "skills" | "extensions" | "about";

/** Also drives the router's /settings/:section validation. */
export const SETTINGS_SECTIONS: Array<{
  group: string;
  items: Array<{ id: SectionId; label: string; icon: JSX.Element }>;
}> = [
  {
    group: "个人",
    items: [
      { id: "general", label: "通用", icon: <HugeiconsIcon strokeWidth={2} icon={Settings02Icon} /> },
      { id: "shortcuts", label: "快捷键", icon: <HugeiconsIcon strokeWidth={2} icon={KeyboardIcon} /> },
      { id: "archived", label: "归档对话", icon: <HugeiconsIcon strokeWidth={2} icon={Archive04Icon} /> },
      { id: "usage", label: "使用统计", icon: <HugeiconsIcon strokeWidth={2} icon={Analytics01Icon} /> },
    ],
  },
  {
    group: "集成",
    items: [
      { id: "providers", label: "模型管理", icon: <HugeiconsIcon strokeWidth={2} icon={BoxesIcon} /> },
      { id: "mcp", label: "MCP 工具", icon: <HugeiconsIcon strokeWidth={2} icon={Plug01Icon} /> },
      { id: "skills", label: "技能", icon: <HugeiconsIcon strokeWidth={2} icon={SparklesIcon} /> },
      { id: "extensions", label: "插件", icon: <HugeiconsIcon strokeWidth={2} icon={PuzzleIcon} /> },
    ],
  },
  {
    group: "关于",
    items: [
      { id: "about", label: "关于", icon: <HugeiconsIcon strokeWidth={2} icon={InformationCircleIcon} /> },
    ],
  },
];


function Group({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-2">
      {title ? <h3 className="px-1 text-sm font-medium">{title}</h3> : null}
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
        <Label className="text-sm font-medium">{title}</Label>
        {description ? (
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

/**
 * Settings is a route (`#/settings/<section>`), not a modal: the shell stays
 * mounted behind it and every pane is deep-linkable, so the composer's
 * 「管理模型」 can jump straight to the model-management pane.
 */
export function SettingsDialog({
  open,
  onOpenChange,
  onProvidersChanged,
  onDeleteConversations,
  models = [],
  section: controlledSection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProvidersChanged?: () => void;
  /** Deletes conversations for Settings → 归档对话, then re-syncs the shell. */
  onDeleteConversations?: (ids: string[]) => Promise<DeleteConversationsResult>;
  /** Model catalog, for the 默认模型 picker. */
  models?: FastVibeModel[];
  /** Active sub-route, e.g. "providers". */
  section?: SectionId;
}): JSX.Element | null {
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);
  const reset = useSettingsStore((state) => state.reset);
  const navigate = useNavigate();
  const [section, setSection] = useState<SectionId>(controlledSection ?? "general");
  const [info, setInfo] = useState<AppInfo | null>(null);
  // The conversation sidebar is resizable; match whatever width it currently has.
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);

  useEffect(() => {
    if (open) setSidebarWidth(readSidebarWidth());
  }, [open]);

  useEffect(() => {
    if (open && !info) {
      void window.fastvibe.app.getInfo().then(setInfo).catch(() => undefined);
    }
  }, [open, info]);

  // The dialog stays mounted while closed, so re-apply the route's section on open.
  useEffect(() => {
    if (open && controlledSection) setSection(controlledSection);
  }, [open, controlledSection]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("[data-shortcut-recording]") !== null) return;
      event.preventDefault();
      onOpenChange(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  // Every sidebar entry is a real URL, so history (and back/forward) just works.
  const goToSection = (id: SectionId): void => {
    setSection(id);
    navigate(`/settings/${id}`, { replace: true });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex bg-background">
      <aside
        className="flex shrink-0 flex-col border-r border-border bg-sidebar"
        style={{ width: sidebarWidth }}
      >
        <div className="drag-region h-11 shrink-0" />
        <div className="no-drag px-2 pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start gap-2.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            onClick={() => onOpenChange(false)}
          >
            <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} className="size-4" />
            返回应用
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-2 py-3">
          {SETTINGS_SECTIONS.map((group) => (
            <div key={group.group} className="mb-3">
              <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.group}</p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={cn(
                      "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-sm",
                      section === item.id ? "bg-sidebar-accent font-medium" : "hover:bg-sidebar-accent/50",
                    )}
                    onClick={() => goToSection(item.id)}
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
        <div className="mx-auto w-full max-w-200 px-8 py-8">
          <h2 className="mb-5 text-xl font-medium tracking-tight">
            {SETTINGS_SECTIONS.flatMap((group) => group.items).find((item) => item.id === section)?.label}
          </h2>

          {section === "general" ? (
            <div className="space-y-6">
              <Group title="外观">
                <Row
                  title="主题模式"
                  description="跟随系统时随 macOS 外观自动切换"
                  control={
                    <Select
                      items={THEME_MODE_ITEMS}
                      value={settings.themeMode}
                      onValueChange={(value) => update({ themeMode: value as ThemeMode })}
                    >
                      <SelectTrigger size="sm" className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="system">跟随系统</SelectItem>
                        <SelectItem value="light">亮色</SelectItem>
                        <SelectItem value="dark">暗色</SelectItem>
                      </SelectContent>
                    </Select>
                  }
                />
                <Row
                  title="亮色主题"
                  description="亮色模式下使用的主题"
                  control={
                    <ThemeSelect
                      kind="light"
                      value={settings.lightTheme}
                      onChange={(id) => update({ lightTheme: id })}
                    />
                  }
                />
                <Row
                  title="暗色主题"
                  description="暗色模式下使用的主题"
                  control={
                    <ThemeSelect
                      kind="dark"
                      value={settings.darkTheme}
                      onChange={(id) => update({ darkTheme: id })}
                    />
                  }
                />
                <Row
                  title="界面字号"
                  control={
                    <Select
                      items={UI_FONT_SIZE_ITEMS}
                      value={String(settings.uiFontSize)}
                      onValueChange={(value) => update({ uiFontSize: Number(value) })}
                    >
                      <SelectTrigger size="sm" className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {uiFontSizeValues().map((size) => (
                          <SelectItem key={size} value={String(size)}>
                            {size}px
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  }
                />
              </Group>
              <Group title="通用">
                <Row
                  title="默认模型"
                  description="新开会话默认使用的模型"
                  control={
                    <DefaultModelSelect
                      models={models}
                      value={settings.defaultModel}
                      onChange={(model: EngineModel | undefined) => update({ defaultModel: model })}
                    />
                  }
                />
                <Row
                  title="默认推理强度"
                  description="模型不支持所选档位时会自动回退"
                  control={
                    <Select
                      items={THINKING_ITEMS}
                      value={settings.thinkingLevel}
                      onValueChange={(value) => update({ thinkingLevel: value as typeof settings.thinkingLevel })}
                    >
                      <SelectTrigger size="sm" className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(THINKING_MENU_LABELS) as Array<keyof typeof THINKING_MENU_LABELS>).map((key) => (
                          <SelectItem key={key} value={key}>
                            {THINKING_MENU_LABELS[key]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  }
                />
                <Row
                  title="默认权限模式"
                  description={`${PERMISSION_DESCRIPTIONS[settings.defaultPermissionMode]}；启动时默认使用，输入框上方可临时切换`}
                  control={
                    <Select
                      items={PERMISSION_MODE_ITEMS}
                      value={settings.defaultPermissionMode}
                      onValueChange={(value) =>
                        // Also retarget the live mode, so changing the default from here
                        // does not leave the running session on the old mode.
                        update({ defaultPermissionMode: value as PermissionMode, permissionMode: value as PermissionMode })
                      }
                    >
                      <SelectTrigger size="sm" className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PERMISSION_MODES.map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {PERMISSION_MODE_ITEMS[mode]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  }
                />
                <Row
                  title="运行时保持唤醒"
                  description="Agent 运行期间阻止系统休眠，回合结束后恢复"
                  control={
                    <Switch
                      checked={settings.keepAwake}
                      onCheckedChange={(checked) => update({ keepAwake: checked })}
                    />
                  }
                />
              </Group>
              <Group title="对话">
                <Row
                  title="流式时新消息处理"
                  description="生成过程中发送消息的默认行为"
                  control={
                    <Select
                      items={QUEUE_ITEMS}
                      value={settings.queueBehavior}
                      onValueChange={(value) => update({ queueBehavior: value as typeof settings.queueBehavior })}
                    >
                      <SelectTrigger size="sm" className="w-44">
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
                  title="打断方式"
                  description="默认打断时是否等当前回合结束"
                  control={
                    <Select
                      items={INTERRUPT_ITEMS}
                      value={settings.interruptMode}
                      onValueChange={(value) => update({ interruptMode: value as typeof settings.interruptMode })}
                    >
                      <SelectTrigger size="sm" className="w-44">
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
            </div>
          ) : null}

          {section === "shortcuts" ? <ShortcutsSettings /> : null}
          {section === "providers" ? <ProvidersSettings onChanged={() => onProvidersChanged?.()} /> : null}
          {section === "archived" ? <ArchivedSettings onDeleteConversations={onDeleteConversations} /> : null}
          {section === "usage" ? <UsageSettings /> : null}

          {section === "mcp" ? <McpSettings /> : null}
          {section === "skills" ? <SkillsSettings /> : null}
          {section === "extensions" ? <ExtensionsSettings /> : null}

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
                <Row title="FastVibe" control={<span className="text-xs">{info?.version ?? "—"}</span>} />
                <Row title="平台" control={<span className="text-xs">{info?.platform ?? "—"}</span>} />
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
                        <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} />
                        打开
                      </Button>
                    ) : null
                  }
                />
              </Group>
              <AboutUpdate />
              <Button variant="outline" size="sm" onClick={reset}>
                <HugeiconsIcon strokeWidth={2} icon={RotateCcwIcon} />
                恢复默认设置
              </Button>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
