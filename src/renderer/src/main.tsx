import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyThemePreferences } from "@/lib/themes";
import { useSettingsStore } from "@/stores/settings";
import { App } from "./App";
import "./index.css";

// Apply the persisted theme before React mounts so the first paint already uses
// the right palette instead of flashing the default one. The store reads the
// preload snapshot of userData/settings.json (plus a localStorage cache)
// synchronously on creation.
applyThemePreferences(useSettingsStore.getState().settings);

// HashRouter, not BrowserRouter: the production renderer is loaded over file://
// (`window.loadFile`), where path-based history has no server to fall back to and
// a reload on /settings/providers would 404.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </TooltipProvider>
  </StrictMode>,
);
