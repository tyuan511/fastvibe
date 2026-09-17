import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyThemePreferences, applyUiFontSize } from "@/lib/themes";
import { applyUiLanguage } from "@/lib/i18n";
import { dismissBootLoader } from "@/lib/boot-loader";
import { installRendererLogger } from "@/lib/logger";
import { useSettingsStore } from "@/stores/settings";
import { App } from "./App";
import { ErrorBoundary } from "./components/error-boundary";
import "./index.css";

installRendererLogger();

// Apply the persisted theme before React mounts so the first paint already uses
// the right palette instead of flashing the default one. The store reads the
// preload snapshot of userData/settings.json (plus a localStorage cache)
// synchronously on creation.
applyThemePreferences(useSettingsStore.getState().settings);
// Same for 界面字号: the root font size is the scale factor for every rem in the
// app, so stamping it pre-mount avoids a one-frame flash at the default size.
applyUiFontSize(useSettingsStore.getState().settings.uiFontSize);
// And 界面语言, so the first paint is already in the persisted language instead of
// the OS-detected one the i18n instance starts on.
applyUiLanguage(useSettingsStore.getState().settings.uiLanguage);

// The boot splash (index.html) is normally dismissed by App once the engine has
// settled. When the engine stalls the splash must still lift, or the window would
// stay covered by a full-screen overlay, so arm a hard cap here.
window.setTimeout(dismissBootLoader, 8000);

// HashRouter, not BrowserRouter: the production renderer is loaded over file://
// (`window.loadFile`), where path-based history has no server to fall back to and
// a reload on /settings/providers would 404.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <TooltipProvider>
        <HashRouter>
          <App />
        </HashRouter>
      </TooltipProvider>
    </ErrorBoundary>
  </StrictMode>,
);
