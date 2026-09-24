import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { PROVIDER_APIS, type CcSwitchCandidate, type CcSwitchScan, type EngineModel, type FastVibeModel, type GatewayKind, type Project, type ProjectModelDefault, type NativeProviderConfig, type ProviderApi, type ProviderConfig, type ProviderModel } from "@shared/types";
import { ModelThinkingSelect } from "@/components/model-thinking-select";
import { useSettingsStore } from "@/stores/settings";
import { useSessionStore } from "@/stores/session";

export function ProjectDefaultsSection({ models }: { models: FastVibeModel[] }): JSX.Element {
  const { t } = useTranslation("settings");
  const projects = useSessionStore((state) => state.projects);
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.update);
  const [open, setOpen] = useState(false);
  const [selectedCwd, setSelectedCwd] = useState<string>();
  const [draft, setDraft] = useState<{ model?: EngineModel; thinkingLevel: typeof settings.thinkingLevel }>({
    thinkingLevel: "auto",
  });
  const projectDefaults = settings.projectDefaults ?? {};
  const localProjects = projects.filter((project) => project.kind !== "remote");
  const configured = localProjects.filter((project) => Boolean(projectDefaults[project.cwd]));
  const unconfigured = localProjects.filter((project) => !projectDefaults[project.cwd]);
  const selectedProject = localProjects.find((project) => project.cwd === selectedCwd);

  useEffect(() => {
    if (!open) return;
    setSelectedCwd((current) => {
      if (current && localProjects.some((project) => project.cwd === current)) return current;
      return unconfigured[0]?.cwd ?? configured[0]?.cwd;
    });
  }, [configured, localProjects, open, unconfigured]);

  useEffect(() => {
    const preference = selectedCwd ? projectDefaults[selectedCwd] : undefined;
    setDraft(preference ? { model: preference.model, thinkingLevel: preference.thinkingLevel } : { thinkingLevel: "auto" });
  }, [projectDefaults, selectedCwd]);

  function save(cwd: string, next: { model?: EngineModel; thinkingLevel: typeof settings.thinkingLevel }): void {
    if (!next.model) {
      const rest = { ...projectDefaults };
      delete rest[cwd];
      updateSettings({ projectDefaults: Object.keys(rest).length > 0 ? rest : undefined });
      return;
    }
    const entry: ProjectModelDefault = { model: next.model, thinkingLevel: next.thinkingLevel };
    updateSettings({ projectDefaults: { ...projectDefaults, [cwd]: entry } });
  }

  function updateDraft(next: { model?: EngineModel; thinkingLevel: typeof settings.thinkingLevel }): void {
    setDraft(next);
    if (selectedProject && next.model) save(selectedProject.cwd, next);
    if (selectedProject && !next.model && projectDefaults[selectedProject.cwd]) save(selectedProject.cwd, next);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("projectDefaults.title")}</p>
          <p className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">{t("projectDefaults.desc")}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setOpen(true)}>
          {t("projectDefaults.configuredCount", { count: configured.length })}
          <span className="text-muted-foreground">·</span>
          {t("projectDefaults.manage")}
        </Button>
      </div>

      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] w-[min(88vw,40rem)] max-w-[calc(100%-2rem)] h-[36rem] max-h-[calc(100vh-2rem)] overflow-hidden sm:max-w-[min(88vw,40rem)]">
        <DialogHeader>
          <DialogTitle>{t("projectDefaults.title")}</DialogTitle>
          <DialogDescription>{t("projectDefaults.desc")}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 h-full overflow-hidden rounded-lg border border-border md:grid-cols-[minmax(14rem,0.8fr)_minmax(0,1.2fr)]">
          <div className="min-h-0 min-w-0 overflow-y-auto p-2 md:border-r md:border-border">
            <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{t("projectDefaults.unconfigured")}</p>
            {unconfigured.length > 0 ? (
              <div className="space-y-0.5">
                {unconfigured.map((project) => (
                  <ProjectDefaultRow
                    key={project.cwd}
                    project={project}
                    selected={selectedCwd === project.cwd}
                    onSelect={() => setSelectedCwd(project.cwd)}
                  />
                ))}
              </div>
            ) : (
              <p className="px-2 py-3 text-xs text-muted-foreground">{localProjects.length === 0 ? t("projectDefaults.noProjects") : t("projectDefaults.allConfigured")}</p>
            )}
            {configured.length > 0 ? (
              <div className="mt-2 border-t border-border pt-2">
                <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{t("projectDefaults.configured")}</p>
                <div className="space-y-0.5">
                  {configured.map((project) => (
                    <ProjectDefaultRow
                      key={project.cwd}
                      project={project}
                      selected={selectedCwd === project.cwd}
                      onSelect={() => setSelectedCwd(project.cwd)}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="min-w-0 p-4">
            {selectedProject ? (
              <div className="space-y-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{selectedProject.name || selectedProject.cwd}</p>
                  <p className="truncate text-xs text-muted-foreground" title={selectedProject.cwd}>{selectedProject.cwd}</p>
                </div>
                <ModelThinkingSelect
                  models={models}
                  model={draft.model}
                  thinkingLevel={draft.thinkingLevel}
                  allowAuto
                  surface="settings"
                  className="w-full"
                  ariaLabel={t("projectDefaults.modelLabel")}
                  emptyModelLabel={t("projectDefaults.inheritGlobal")}
                  inheritModelLabel={t("projectDefaults.inheritGlobal")}
                  onModelChange={(model) => updateDraft({ ...draft, model })}
                  onThinkingChange={(thinkingLevel) => updateDraft({ ...draft, thinkingLevel })}
                />
                <p className="text-xs leading-4 text-muted-foreground">{t("projectDefaults.hint")}</p>
              </div>
            ) : (
              <p className="py-8 text-center text-xs text-muted-foreground">{t("projectDefaults.selectProject")}</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
function ProjectDefaultRow({ project, selected, onSelect }: { project: Project; selected: boolean; onSelect: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className={cn("flex min-h-9 w-full items-center rounded-md px-2 text-left text-sm", selected ? "bg-muted font-medium" : "hover:bg-muted/60")}
      onClick={onSelect}
      title={project.cwd}
    >
      <span className="min-w-0 truncate">{project.name || project.cwd}</span>
    </button>
  );
}
