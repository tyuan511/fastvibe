import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowRight01Icon,
  BotIcon,
  Delete02Icon,
  Edit02Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ModelThinkingSelect } from "@/components/model-thinking-select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { THINKING_EFFORT_LEVELS, type EngineModel, type FastVibeModel, type SubagentConfig, type SubagentDraft, type ThinkingLevel } from "@shared/types";
import { thinkingLabel } from "@/lib/thinking-levels";
import { cn } from "@/lib/utils";

function modelValue(model?: string): EngineModel | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

function modelText(model?: EngineModel): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

const AGENT_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
type AgentTool = (typeof AGENT_TOOLS)[number];

type FormState = {
  id?: string;
  name: string;
  description: string;
  tools: string[];
  model?: EngineModel;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
};

function formFrom(config?: SubagentConfig): FormState {
  return {
    id: config?.source === "custom" ? config.id : undefined,
    name: config?.name ?? "",
    description: config?.description ?? "",
    tools: config?.tools ?? ["read", "grep", "find", "ls"],
    model: modelValue(config?.model),
    thinkingLevel: config?.thinkingLevel ?? "medium",
    systemPrompt: config?.systemPrompt ?? "",
  };
}

export function SubagentsSettings({ models }: { models: FastVibeModel[] }): JSX.Element {
  const { t } = useTranslation("settings");
  const [agents, setAgents] = useState<SubagentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<FormState | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setAgents(await window.fastvibe.engine.listAgentConfigs());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("subagents.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const builtins = useMemo(() => agents.filter((agent) => agent.source === "builtin"), [agents]);
  const custom = useMemo(() => agents.filter((agent) => agent.source === "custom"), [agents]);

  async function saveBuiltin(
    agent: SubagentConfig,
    patch: { model?: EngineModel; thinkingLevel: ThinkingLevel },
  ): Promise<void> {
    setSaving(true);
    try {
      setAgents(await window.fastvibe.engine.saveAgentConfig({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        tools: agent.tools,
        model: modelText(patch.model),
        thinkingLevel: patch.thinkingLevel,
        systemPrompt: agent.systemPrompt,
      }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("subagents.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function saveCustom(): Promise<void> {
    if (!editor) return;
    setSaving(true);
    const draft: SubagentDraft = {
      id: editor.id,
      name: editor.name,
      description: editor.description,
      tools: editor.tools,
      model: modelText(editor.model),
      thinkingLevel: editor.thinkingLevel,
      systemPrompt: editor.systemPrompt,
    };
    try {
      setAgents(await window.fastvibe.engine.saveAgentConfig(draft));
      setEditor(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("subagents.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function removeCustom(): Promise<void> {
    if (!removeId) return;
    setSaving(true);
    try {
      setAgents(await window.fastvibe.engine.removeAgentConfig(removeId));
      setRemoveId(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("subagents.removeFailed"));
    } finally {
      setSaving(false);
    }
  }

  function renderConfig(agent: SubagentConfig): JSX.Element {
    return (
      <ModelThinkingSelect
        models={models}
        model={modelValue(agent.model)}
        thinkingLevel={agent.thinkingLevel}
        fallbackThinkingLevels={THINKING_EFFORT_LEVELS}
        inheritModelLabel={t("subagents.inheritModel")}
        surface="settings"
        disabled={saving}
        ariaLabel={`${agent.name} · ${t("subagents.modelAndThinking")}`}
        onModelChange={(model) => void saveBuiltin(agent, { model, thinkingLevel: agent.thinkingLevel })}
        onThinkingChange={(thinkingLevel) => void saveBuiltin(agent, {
          model: modelValue(agent.model),
          thinkingLevel,
        })}
      />
    );
  }

  function renderCard(agent: SubagentConfig): JSX.Element {
    const isBuiltin = agent.source === "builtin";
    return (
      <Item
        key={agent.id}
        variant="outline"
        size="sm"
        className={cn(
          "items-start gap-3 bg-card/80 p-3 transition-colors hover:border-primary/30 hover:bg-muted/20",
          isBuiltin && "flex-wrap sm:flex-nowrap",
        )}
      >
        <ItemMedia variant="icon" className="mt-0.5 size-9 rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
          <HugeiconsIcon icon={BotIcon} strokeWidth={1.8} className="size-5" />
        </ItemMedia>
        <ItemContent className="min-w-0 gap-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <ItemTitle className="min-w-0 truncate text-base">{agent.name}</ItemTitle>
            <Badge variant={isBuiltin ? "secondary" : "outline"} className="shrink-0 rounded-full px-2 py-0.5 text-xs">
              {isBuiltin ? t("subagents.builtin") : t("subagents.custom")}
            </Badge>
          </div>
          <ItemDescription className="line-clamp-1">{agent.description}</ItemDescription>
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {agent.tools.map((tool) => (
              <span key={tool} className="rounded-md bg-muted/70 px-1.5 py-0.5 text-xs text-muted-foreground">
                {AGENT_TOOLS.includes(tool as AgentTool) ? t(`subagents.toolOptions.${tool}.label`) : t("subagents.toolOptions.other")}
              </span>
            ))}
          </div>
        </ItemContent>
        {isBuiltin ? (
          <ItemActions className="w-full sm:hidden">
            <div className="w-full">{renderConfig(agent)}</div>
          </ItemActions>
        ) : null}
        <ItemActions className={cn("ml-auto shrink-0 self-center", isBuiltin && "hidden sm:flex")}>
          <div className="hidden min-w-44 sm:block">
            {isBuiltin ? renderConfig(agent) : (
              <button type="button" className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-left text-sm hover:border-primary/40" onClick={() => setEditor(formFrom(agent))}>
                <span className="min-w-0 truncate text-muted-foreground">
                  {agent.model ?? t("subagents.inheritModel")} · {thinkingLabel(agent.thinkingLevel)}
                </span>
                <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-4 shrink-0 text-primary" />
              </button>
            )}
          </div>
          {!isBuiltin ? (
            <>
              <Button size="icon-sm" variant="ghost" aria-label={t("subagents.edit")} onClick={() => setEditor(formFrom(agent))}>
                <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
              </Button>
              <Button size="icon-sm" variant="ghost" className="text-muted-foreground hover:text-destructive" aria-label={t("subagents.remove")} onClick={() => setRemoveId(agent.id)}>
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              </Button>
            </>
          ) : null}
        </ItemActions>
      </Item>
    );
  }

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
            <HugeiconsIcon icon={BotIcon} strokeWidth={1.8} className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("subagents.desc")}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">{t("subagents.fallback")}</p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2 sm:self-start">
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading || saving}>
            <HugeiconsIcon icon={Refresh01Icon} strokeWidth={2} />
            {t("subagents.refresh")}
          </Button>
          <Button size="sm" onClick={() => setEditor(formFrom())}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {t("subagents.add")}
          </Button>
        </div>
      </div>

      {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">{t("subagents.loading")}</p> : null}
      {!loading && builtins.length > 0 ? (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t("subagents.builtins")}</h3>
            <span className="text-xs text-muted-foreground">{builtins.length}</span>
          </div>
          <div className="grid gap-2.5">{builtins.map(renderCard)}</div>
        </section>
      ) : null}
      {!loading && custom.length > 0 ? (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t("subagents.customs")}</h3>
            <span className="text-xs text-muted-foreground">{custom.length}</span>
          </div>
          <div className="grid gap-2.5">{custom.map(renderCard)}</div>
        </section>
      ) : null}
      {!loading && custom.length === 0 ? <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{t("subagents.empty")}</p> : null}

      <Dialog open={editor !== null} onOpenChange={(open) => { if (!open && !saving) setEditor(null); }}>
        <DialogContent className="max-h-[85vh] min-h-0 overflow-hidden sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editor?.id ? t("subagents.editTitle") : t("subagents.addTitle")}</DialogTitle>
            <DialogDescription>{t("subagents.formDesc")}</DialogDescription>
          </DialogHeader>
          {editor ? (
            <div className="-mx-1 grid min-h-0 gap-4 overflow-y-auto px-1">
              <div className="grid gap-1.5">
                <Label htmlFor="subagent-name">{t("subagents.name")}</Label>
                <Input id="subagent-name" value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} />
                <p className="text-xs text-muted-foreground">{t("subagents.nameHint")}</p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="subagent-description">{t("subagents.description")}</Label>
                <Input id="subagent-description" value={editor.description} onChange={(event) => setEditor({ ...editor, description: event.target.value })} />
              </div>
              <div className="grid gap-2">
                <div>
                  <Label>{t("subagents.tools")}</Label>
                  <p className="mt-1 text-xs text-muted-foreground">{t("subagents.toolsHint")}</p>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {AGENT_TOOLS.map((tool) => {
                    const checked = editor.tools.includes(tool);
                    return (
                      <label key={tool} className="flex cursor-pointer items-center gap-1.5 text-sm">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(value) => setEditor({
                            ...editor,
                            tools: value === true
                              ? [...new Set([...editor.tools, tool])]
                              : editor.tools.filter((item) => item !== tool),
                          })}
                        />
                        <span>{t(`subagents.toolOptions.${tool}.label`)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label>{t("subagents.modelAndThinking")}</Label>
                <ModelThinkingSelect
                  models={models}
                  model={editor.model}
                  thinkingLevel={editor.thinkingLevel}
                  fallbackThinkingLevels={THINKING_EFFORT_LEVELS}
                  inheritModelLabel={t("subagents.inheritModel")}
                  surface="settings"
                  disabled={saving}
                  ariaLabel={t("subagents.modelAndThinking")}
                  onModelChange={(model) => setEditor({ ...editor, model })}
                  onThinkingChange={(thinkingLevel) => setEditor({ ...editor, thinkingLevel })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="subagent-prompt">{t("subagents.prompt")}</Label>
                <Textarea id="subagent-prompt" className="min-h-24 resize-y leading-6" value={editor.systemPrompt} onChange={(event) => setEditor({ ...editor, systemPrompt: event.target.value })} />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(null)} disabled={saving}>{t("subagents.cancel")}</Button>
            <Button onClick={() => void saveCustom()} disabled={saving}>{t("subagents.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={removeId !== null} onOpenChange={(open) => { if (!open && !saving) setRemoveId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("subagents.removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("subagents.removeDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>{t("subagents.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void removeCustom()} disabled={saving}>{t("subagents.remove")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
