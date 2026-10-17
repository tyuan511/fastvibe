import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { toast, Toaster } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { GitCompareIcon } from "@hugeicons/core-free-icons";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidePaneGit } from "@/components/layout/side-pane-git";
import { applyThemePreferences } from "@/lib/themes";
import { applyUiLanguage, i18n } from "@/lib/i18n";
import { useSettingsStore } from "@/stores/settings";
import { PREVIEW_CWD } from "./preview-data";
import "../index.css";

const previewWidth = Number(new URLSearchParams(window.location.search).get("width"));
const settings = useSettingsStore.getState().settings;
applyThemePreferences(settings);
applyUiLanguage(settings.uiLanguage);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground" style={{ maxWidth: Number.isFinite(previewWidth) && previewWidth >= 320 ? previewWidth : undefined }}>
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs font-medium"><HugeiconsIcon icon={GitCompareIcon} size={14} />{i18n.t("sidepane:tabs.git")}<span className="ml-auto font-normal text-muted-foreground">FastVibe</span></div>
        <SidePaneGit cwd={PREVIEW_CWD} onError={(message) => toast.error(message)} />
      </div>
      <Toaster />
    </TooltipProvider>
  </StrictMode>,
);
