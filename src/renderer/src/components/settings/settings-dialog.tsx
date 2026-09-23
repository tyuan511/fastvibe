import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
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
import type { EngineModel, FastVibeModel, ImportRunResult, WorkspaceSnapshot } from "@shared/types";
import { useSettingsStore } from "@/stores/settings";
import { i18n } from "@/lib/i18n";
import { UI_LANGUAGES, UI_LANGUAGE_LABELS, type UiLanguage } from "@/lib/language";
import { PERMISSION_MODES, permissionDescription, permissionLabel, permissionModeItems } from "@/lib/permission-modes";
import { clearRememberedPermissions } from "@/lib/permission-rules";
import type { ThemeMode } from "@/lib/themes";
import { UI_FONT_SIZE_MAX, UI_FONT_SIZE_MIN, UI_FONT_SIZE_STEP } from "@/lib/themes";
import { readSidebarWidth } from "@/lib/sidebar-width";
import { HAS_CUSTOM_TITLE_BAR } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { ProvidersSettings } from "./providers-settings";
import { ArchivedSettings, type DeleteConversationsResult } from "./archived-settings";
import { ImportSettings } from "./import-settings";
import { DefaultModelSelect } from "./default-model-select";
import { ExtensionsSettings } from "./extensions-settings";
import { McpSettings } from "./mcp-settings";
import { RemoteSettings } from "./remote-settings";
import { RemoteHostsSettings } from "./remote-hosts-settings";
import { ComputerSettings } from "./computer-settings";
import { ProxySettings } from "./proxy-settings";
import { SkillsSettings } from "./skills-settings";
import { THINKING_MENU_ORDER, thinkingMenuItems, thinkingMenuLabel } from "@/lib/thinking-levels";
import { ThemeSelect } from "./theme-select";
import { UsageSettings } from "./usage-settings";
import { ShortcutsSettings } from "./shortcuts-settings";
import { AboutSettings } from "./about-settings";
import { PersonalizationSettings } from "./personalization-settings";
import { SubagentsSettings } from "./subagents-settings";
import { SettingsGroup as Group, SettingsRow as Row } from "./settings-group";
import { usePermissionModeSelection } from "@/components/permission-mode-provider";
import {
  SETTINGS_SECTIONS,
  settingsGroupLabel,
  settingsSectionLabel,
  type SectionId,
} from "./settings-sections";


const UI_FONT_SIZE_ITEMS: Record<string, string> = {};
function uiFontSizeValues(): number[] {
  const values: number[] = [];
  for (let size = UI_FONT_SIZE_MIN; size <= UI_FONT_SIZE_MAX; size += UI_FONT_SIZE_STEP) values.push(size);
  return values;
}
for (const size of uiFontSizeValues()) UI_FONT_SIZE_ITEMS[String(size)] = `${size}px`;

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
  onImported,
  models = [],
  section: controlledSection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProvidersChanged?: () => void;
  /** Deletes conversations for Settings → 归档对话, then re-syncs the shell. */
  onDeleteConversations?: (ids: string[]) => Promise<DeleteConversationsResult>;
  /** Sessions imported in Settings → 导入, so the sidebar picks the new chats up. */
  onImported?: (snapshot: WorkspaceSnapshot, result: ImportRunResult) => void;
  /** Model catalog, for the 默认模型 picker. */
  models?: FastVibeModel[];
  /** Active sub-route, e.g. "providers". */
  section?: SectionId;
}): JSX.Element | null {
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);
  const { setPermissionMode } = usePermissionModeSelection();
  // 始终允许 rules, so the revoke button can say how many there are and disable itself.
  const remembered = settings.permissionAlways ?? [];
  const { t } = useTranslation("settings");
  const navigate = useNavigate();
  const [section, setSection] = useState<SectionId>(controlledSection ?? "general");
  // The conversation sidebar is resizable; match whatever width it currently has.
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);

  useEffect(() => {
    if (open) setSidebarWidth(readSidebarWidth());
  }, [open]);

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
    <div className={cn("fixed inset-x-0 bottom-0 z-50 flex bg-background", HAS_CUSTOM_TITLE_BAR ? "top-11" : "top-0")}>
      <aside
        className="flex shrink-0 flex-col border-r border-border bg-sidebar"
        style={{ width: sidebarWidth }}
      >
        {/* Under a title bar of our own this row is the bar's job; the pane itself
            starts at the top. On macOS it is the traffic lights' clearance. */}
        {HAS_CUSTOM_TITLE_BAR ? null : <div className="drag-region h-11 shrink-0" />}
        <div className="no-drag px-2 pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start gap-2.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            onClick={() => onOpenChange(false)}
          >
            <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} className="size-4" />
            {t("backToApp")}
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-2 py-3">
          {SETTINGS_SECTIONS.map((group) => (
            <div key={group.group} className="mb-3">
              <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{settingsGroupLabel(group.group)}</p>
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
                    {settingsSectionLabel(item.id)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </ScrollArea>
      </aside>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-200 px-8 py-8">
          <h2 className={cn("mb-5 text-xl font-medium tracking-tight", section === "usage" && "hidden")}>
            {settingsSectionLabel(section)}
          </h2>

          {section === "general" ? (
            <div className="space-y-6">
              <Group title={t("language.title")}>
                <Row
                  title={t("language.ui")}
                  description={t("language.uiDesc")}
                  control={
                    <Select
                      items={UI_LANGUAGE_LABELS}
                      value={settings.uiLanguage}
                      onValueChange={(value) => update({ uiLanguage: value as UiLanguage })}
                    >
                      <SelectTrigger size="sm" className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {UI_LANGUAGES.map((language) => (
                          <SelectItem key={language} value={language}>
                            {UI_LANGUAGE_LABELS[language]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  }
                />
                <Row
                  title={t("language.ai")}
                  description={t("language.aiDesc")}
                  control={
                    <Select
                      items={UI_LANGUAGE_LABELS}
                      value={settings.aiLanguage}
                      onValueChange={(value) => update({ aiLanguage: value as UiLanguage })}
                    >
                      <SelectTrigger size="sm" className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {UI_LANGUAGES.map((language) => (
                          <SelectItem key={language} value={language}>
                            {UI_LANGUAGE_LABELS[language]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  }
                />
              </Group>
              <Group title={t("appearance.title")}>
                <Row
                  title={t("appearance.themeMode")}
                  description={t("appearance.themeModeDesc")}
                  control={
                    <Select
                      items={{
                        system: t("appearance.system"),
                        light: t("appearance.light"),
                        dark: t("appearance.dark"),
                      }}
                      value={settings.themeMode}
                      onValueChange={(value) => update({ themeMode: value as ThemeMode })}
                    >
                      <SelectTrigger size="sm" className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="system">{t("appearance.system")}</SelectItem>
                        <SelectItem value="light">{t("appearance.light")}</SelectItem>
                        <SelectItem value="dark">{t("appearance.dark")}</SelectItem>
                      </SelectContent>
                    </Select>
                  }
                />
                <Row
                  title={t("appearance.lightTheme")}
                  description={t("appearance.lightThemeDesc")}
                  control={
                    <ThemeSelect
                      kind="light"
                      value={settings.lightTheme}
                      onChange={(id) => update({ lightTheme: id })}
                    />
                  }
                />
                <Row
                  title={t("appearance.darkTheme")}
                  description={t("appearance.darkThemeDesc")}
                  control={
                    <ThemeSelect
                      kind="dark"
                      value={settings.darkTheme}
                      onChange={(id) => update({ darkTheme: id })}
                    />
                  }
                />
                <Row
                  title={t("appearance.uiFontSize")}
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
              <Group title={t("agent.title")}>
                <Row
                  title={t("common.defaultModel")}
                  description={t("common.defaultModelDesc")}
                  control={
                    <DefaultModelSelect
                      models={models}
                      value={settings.defaultModel}
                      onChange={(model: EngineModel | undefined) => update({ defaultModel: model })}
                    />
                  }
                />
                <Row
                  title={t("common.thinking")}
                  description={t("common.thinkingDesc")}
                  control={
                    <Select
                      items={thinkingMenuItems()}
                      value={settings.thinkingLevel}
                      onValueChange={(value) => update({ thinkingLevel: value as typeof settings.thinkingLevel })}
                    >
                      <SelectTrigger size="sm" className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {THINKING_MENU_ORDER.map((key) => (
                          <SelectItem key={key} value={key}>
                            {thinkingMenuLabel(key)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  }
                />
              </Group>
              <Group title={t("security.title")}>
                <Row
                  title={t("common.permission")}
                  description={t("common.permissionDesc", { mode: permissionDescription(settings.defaultPermissionMode) })}
                  control={
                    <Select
                      items={permissionModeItems()}
                      value={settings.defaultPermissionMode}
                      onValueChange={(value) => setPermissionMode(value as typeof settings.defaultPermissionMode)}
                    >
                      <SelectTrigger size="sm" className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PERMISSION_MODES.map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {permissionLabel(mode)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  }
                />
                <Row
                  title={t("common.permissionRules")}
                  description={t("common.permissionRulesDesc", { count: remembered.length })}
                  control={
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={remembered.length === 0}
                      onClick={() => clearRememberedPermissions()}
                    >
                      {t("common.permissionRulesClear")}
                    </Button>
                  }
                />
              </Group>
              <ProxySettings />
              <Group title={t("runtime.title")}>
                <Row
                  title={t("common.keepAwake")}
                  description={t("common.keepAwakeDesc")}
                  control={
                    <Switch
                      checked={settings.keepAwake}
                      onCheckedChange={(checked) => update({ keepAwake: checked })}
                    />
                  }
                />
                <Row
                  title={t("common.notifications")}
                  description={t("common.notificationsDesc")}
                  control={
                    <Switch
                      checked={settings.notifyDone && settings.notifyError && settings.notifyApproval && settings.notifyUpdate}
                      onCheckedChange={(checked) =>
                        update({
                          notifyDone: checked,
                          notifyError: checked,
                          notifyApproval: checked,
                          notifyUpdate: checked,
                        })
                      }
                    />
                  }
                />
                <Row
                  title={t("common.notifyDone")}
                  description={t("common.notifyDoneDesc")}
                  control={
                    <Switch
                      checked={settings.notifyDone}
                      onCheckedChange={(checked) => update({ notifyDone: checked })}
                    />
                  }
                />
                <Row
                  title={t("common.notifyError")}
                  description={t("common.notifyErrorDesc")}
                  control={
                    <Switch
                      checked={settings.notifyError}
                      onCheckedChange={(checked) => update({ notifyError: checked })}
                    />
                  }
                />
                <Row
                  title={t("common.notifyApproval")}
                  description={t("common.notifyApprovalDesc")}
                  control={
                    <Switch
                      checked={settings.notifyApproval}
                      onCheckedChange={(checked) => update({ notifyApproval: checked })}
                    />
                  }
                />
                <Row
                  title={t("common.notifyUpdate")}
                  description={t("common.notifyUpdateDesc")}
                  control={
                    <Switch
                      checked={settings.notifyUpdate}
                      onCheckedChange={(checked) => update({ notifyUpdate: checked })}
                    />
                  }
                />
              </Group>
              <Group title={t("chat.title")}>
                <Row
                  title={t("chat.queue")}
                  description={t("chat.queueDesc")}
                  control={
                    <Select
                      items={{ followUp: t("chat.followUp"), steer: t("chat.steer") }}
                      value={settings.queueBehavior}
                      onValueChange={(value) => update({ queueBehavior: value as typeof settings.queueBehavior })}
                    >
                      <SelectTrigger size="sm" className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="followUp">{t("chat.followUp")}</SelectItem>
                        <SelectItem value="steer">{t("chat.steer")}</SelectItem>
                      </SelectContent>
                    </Select>
                  }
                />
                <Row
                  title={t("chat.interrupt")}
                  description={t("chat.interruptDesc")}
                  control={
                    <Select
                      items={{ immediate: t("chat.immediate"), wait: t("chat.wait") }}
                      value={settings.interruptMode}
                      onValueChange={(value) => update({ interruptMode: value as typeof settings.interruptMode })}
                    >
                      <SelectTrigger size="sm" className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="immediate">{t("chat.immediate")}</SelectItem>
                        <SelectItem value="wait">{t("chat.wait")}</SelectItem>
                      </SelectContent>
                    </Select>
                  }
                />
                <Row
                  title={t("chat.autoCompact")}
                  description={t("chat.autoCompactDesc")}
                  control={
                    <Switch
                      checked={settings.autoCompact}
                      onCheckedChange={(checked) => update({ autoCompact: checked })}
                    />
                  }
                />
              </Group>
              <Group title={t("display.title")}>
                <Row
                  title={t("chat.collapseRuns")}
                  description={t("chat.collapseRunsDesc")}
                  control={
                    <Switch
                      checked={settings.collapseRuns}
                      onCheckedChange={(checked) => update({ collapseRuns: checked })}
                    />
                  }
                />
                <Row
                  title={t("chat.showThinking")}
                  control={
                    <Switch
                      checked={settings.showThinking}
                      onCheckedChange={(checked) => update({ showThinking: checked })}
                    />
                  }
                />
                <Row
                  title={t("chat.showTimestamps")}
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

          {section === "personalization" ? <PersonalizationSettings /> : null}
          {section === "shortcuts" ? <ShortcutsSettings /> : null}
          {section === "providers" ? <ProvidersSettings onChanged={() => onProvidersChanged?.()} /> : null}
          {section === "archived" ? <ArchivedSettings onDeleteConversations={onDeleteConversations} /> : null}
          {section === "usage" ? <UsageSettings /> : null}
          {section === "remote" ? <RemoteSettings /> : null}
          {section === "ssh" ? <RemoteHostsSettings /> : null}
          {section === "computer" ? <ComputerSettings /> : null}

          {section === "subagents" ? <SubagentsSettings models={models} /> : null}
          {section === "mcp" ? <McpSettings /> : null}
          {section === "skills" ? <SkillsSettings /> : null}
          {section === "extensions" ? <ExtensionsSettings /> : null}
          {section === "import" ? <ImportSettings onImported={onImported} /> : null}

          {section === "about" ? <AboutSettings /> : null}
        </div>
      </ScrollArea>
    </div>
  );
}
