import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyThemePreferences, applyUiFontSize } from "@/lib/themes";
import { dismissBootLoader } from "@/lib/boot-loader";
import { useSettingsStore } from "@/stores/settings";
import { App } from "./App";
import "./index.css";

// Apply the persisted theme before React mounts so the first paint already uses
// the right palette instead of flashing the default one. The store reads the
// preload snapshot of userData/settings.json (plus a localStorage cache)
// synchronously on creation.
applyThemePreferences(useSettingsStore.getState().settings);
// Same for 界面字号: the root font size is the scale factor for every rem in the
// app, so stamping it pre-mount avoids a one-frame flash at the default size.
applyUiFontSize(useSettingsStore.getState().settings.uiFontSize);

// The boot splash (index.html) is normally dismissed by App once the engine has
// settled. When the engine stalls the splash must still lift, or the window would
// stay covered by a full-screen overlay, so arm a hard cap here.
window.setTimeout(dismissBootLoader, 8000);

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
