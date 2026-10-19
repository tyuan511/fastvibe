import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ProvidersSettings } from "@/components/settings/providers-settings";
import { applyThemePreferences, applyUiFontSize } from "@/lib/themes";
import { applyUiLanguage, i18n } from "@/lib/i18n";
import { useSettingsStore } from "@/stores/settings";
import { MODELS } from "./preview-data";
import "../index.css";

// An isolated settings preview, independent of the rest of the workspace shell.
const settings = useSettingsStore.getState().settings;
applyThemePreferences(settings);
applyUiFontSize(settings.uiFontSize);
applyUiLanguage(settings.uiLanguage);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <main className="h-dvh overflow-y-auto bg-background text-foreground">
        <div className="mx-auto w-full max-w-200 px-4 py-5 md:px-8 md:py-8">
          <h2 className="mb-5 text-xl font-medium tracking-tight">{i18n.t("settings:sections.providers")}</h2>
          <ProvidersSettings models={MODELS} onChanged={() => undefined} />
        </div>
      </main>
      <Toaster />
    </TooltipProvider>
  </StrictMode>,
);
