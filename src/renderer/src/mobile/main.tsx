import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyThemePreferences, applyUiFontSize } from "@/lib/themes";
import { applyUiLanguage } from "@/lib/i18n";
import { installRendererLogger } from "@/lib/logger";
import { useSettingsStore } from "@/stores/settings";
import { ErrorBoundary } from "@/components/error-boundary";
import { MobileApp } from "./mobile-app";
import "@/index.css";

installRendererLogger();

// Same pre-mount stamps as the desktop page (`main.tsx`), so the first paint is already
// in the host's theme, interface size and language.
applyThemePreferences(useSettingsStore.getState().settings);
applyUiFontSize(useSettingsStore.getState().settings.uiFontSize);
applyUiLanguage(useSettingsStore.getState().settings.uiLanguage);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <TooltipProvider>
        <MobileApp />
      </TooltipProvider>
    </ErrorBoundary>
  </StrictMode>,
);
