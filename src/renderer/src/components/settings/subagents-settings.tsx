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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import type { EngineModel, FastVibeModel, SubagentConfig, SubagentDraft } from "@shared/types";
import { DefaultModelSelect } from "./default-model-select";

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
  systemPrompt: string;
};

function formFrom(config?: SubagentConfig): FormState {
  return {
    id: config?.source === "custom" ? config.id : undefined,
    name: config?.name ?? "",
    description: config?.description ?? "",
    tools: config?.tools ?? ["read", "grep", "find", "ls"],
    model: modelValue(config?.model),
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

  async function saveBuiltin(agent: SubagentConfig, model?: EngineModel): Promise<void> {
    setSaving(true);
    try {
      setAgents(await window.fastvibe.engine.saveAgentConfig({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        tools: agent.tools,
        model: modelText(model),
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

  function renderModel(agent: SubagentConfig): JSX.Element {
    return (
      <DefaultModelSelect
        models={models}
        value={modelValue(agent.model)}
        emptyLabel={t("subagents.inherit")}
        className="w-full"
        wrapLabel
        onChange={(model) => void saveBuiltin(agent, model)}
      />
    );
  }

  function renderCard(agent: SubagentConfig): JSX.Element {
    const isBuiltin = agent.source === "builtin";
    return (
      <Card
        key={agent.id}
        className="group relative overflow-hidden border-border/70 bg-card/80 shadow-sm transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md"
      >
        <div className="absolute inset-x-0 top-0 h-0.5 bg-primary/60 opacity-0 transition-opacity group-hover:opacity-100" />
        <CardHeader className="gap-4 pb-3">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
              <HugeiconsIcon icon={BotIcon} strokeWidth={1.8} className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <CardTitle className="truncate text-base">{agent.name}</CardTitle>
                <Badge variant={isBuiltin ? "secondary" : "outline"} className="shrink-0 rounded-full px-2 py-0.5 text-xs">
                  {isBuiltin ? t("subagents.builtin") : t("subagents.custom")}
                </Badge>
              </div>
              <p className="mt-1.5 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">{agent.description}</p>
            </div>
            {!isBuiltin ? (
              <div className="flex shrink-0 -mr-2 -mt-2 gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
                <Button size="icon-sm" variant="ghost" aria-label={t("subagents.edit")} onClick={() => setEditor(formFrom(agent))}>
                  <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
                </Button>
                <Button size="icon-sm" variant="ghost" className="text-muted-foreground hover:text-destructive" aria-label={t("subagents.remove")} onClick={() => setRemoveId(agent.id)}>
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                </Button>
              </div>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <div className="flex min-h-7 flex-wrap items-center gap-1.5">
            {agent.tools.map((tool) => (
              <span key={tool} className="rounded-md bg-muted/70 px-2 py-1 text-xs text-muted-foreground">
                {AGENT_TOOLS.includes(tool as AgentTool) ? t(`subagents.toolOptions.${tool}.label`) : t("subagents.toolOptions.other")}
              </span>
            ))}
          </div>
          <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("subagents.model")}</p>
                <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{t("subagents.modelDesc")}</p>
              </div>
              {agent.model ? <Badge variant="outline" className="shrink-0 rounded-full text-xs">{t("subagents.configured")}</Badge> : null}
            </div>
            <div className="mt-3">
              {isBuiltin ? renderModel(agent) : (
                <button type="button" className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm hover:border-primary/40" onClick={() => setEditor(formFrom(agent))}>
                  <span className="min-w-0 break-all leading-5 text-muted-foreground">{agent.model ?? t("subagents.inherit")}</span>
                  <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-4 shrink-0 text-primary" />
                </button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
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
          <div className="grid items-start gap-3 md:grid-cols-2">{builtins.map(renderCard)}</div>
        </section>
      ) : null}
      {!loading && custom.length > 0 ? (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t("subagents.customs")}</h3>
            <span className="text-xs text-muted-foreground">{custom.length}</span>
          </div>
          <div className="grid items-start gap-3 md:grid-cols-2">{custom.map(renderCard)}</div>
        </section>
      ) : null}
      {!loading && custom.length === 0 ? <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{t("subagents.empty")}</p> : null}

      <Dialog open={editor !== null} onOpenChange={(open) => { if (!open && !saving) setEditor(null); }}>
        <DialogContent className="sm:max-w-3xl gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b border-border/70 bg-gradient-to-br from-primary/10 via-background to-background px-6 py-5 pr-12">
            <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
              <HugeiconsIcon icon={BotIcon} strokeWidth={1.8} className="size-5" />
            </div>
            <DialogTitle className="text-lg">{editor?.id ? t("subagents.editTitle") : t("subagents.addTitle")}</DialogTitle>
            <DialogDescription className="mt-1.5 max-w-lg leading-5">{t("subagents.formDesc")}</DialogDescription>
          </DialogHeader>
          {editor ? (
            <div className="max-h-[68vh] overflow-y-auto px-6 py-5">
              <div className="grid gap-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="subagent-name">{t("subagents.name")}</Label>
                    <Input id="subagent-name" value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} />
                    <p className="text-xs leading-4 text-muted-foreground">{t("subagents.nameHint")}</p>
                  </div>
                  <div className="grid gap-2">
                    <Label>{t("subagents.tools")}</Label>
                    <p className="text-xs leading-4 text-muted-foreground">{t("subagents.toolsHint")}</p>
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="subagent-description">{t("subagents.description")}</Label>
                  <Input id="subagent-description" value={editor.description} onChange={(event) => setEditor({ ...editor, description: event.target.value })} />
                </div>
                <div className="grid gap-3 rounded-xl border border-border/70 bg-muted/25 p-4">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {AGENT_TOOLS.map((tool) => {
                      const checked = editor.tools.includes(tool);
                      return (
                        <label key={tool} className="group/field flex cursor-pointer items-start gap-2 rounded-lg border border-transparent bg-background/60 p-2.5 transition-colors hover:border-primary/25 hover:bg-background">
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(value) => setEditor({
                              ...editor,
                              tools: value === true
                                ? [...new Set([...editor.tools, tool])]
                                : editor.tools.filter((item) => item !== tool),
                            })}
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium leading-4">{t(`subagents.toolOptions.${tool}.label`)}</span>
                            <span className="mt-1 block text-xs leading-4 text-muted-foreground">{t(`subagents.toolOptions.${tool}.description`)}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div className="grid gap-2 rounded-xl border border-border/70 bg-muted/25 p-4">
                  <Label>{t("subagents.model")}</Label>
                  <p className="text-xs text-muted-foreground">{t("subagents.modelDesc")}</p>
                  <DefaultModelSelect
                    models={models}
                    value={editor.model}
                    emptyLabel={t("subagents.inherit")}
                    className="w-full"
                    wrapLabel
                    onChange={(model) => setEditor({ ...editor, model })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="subagent-prompt">{t("subagents.prompt")}</Label>
                  <Textarea id="subagent-prompt" className="min-h-52 resize-y leading-6" value={editor.systemPrompt} onChange={(event) => setEditor({ ...editor, systemPrompt: event.target.value })} />
                </div>
              </div>
            </div>
          ) : null}
          <DialogFooter className="border-t border-border/70 px-6 py-4">
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
