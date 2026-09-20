import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Analytics01Icon,
  Archive04Icon,
  BotIcon,
  BoxesIcon,
  ImportIcon,
  InformationCircleIcon,
  KeyboardIcon,
  Plug01Icon,
  PuzzleIcon,
  Settings02Icon,
  SparklesIcon,
  Wifi01Icon,
} from "@hugeicons/core-free-icons";
import { i18n } from "@/lib/i18n";

/**
 * The settings *index*, kept apart from the panes it points at.
 *
 * The shell needs this to validate `#/settings/:section` on every navigation and the
 * command palette lists it, so it has to be reachable without loading the panes —
 * which between them pull in the provider editor, the import sources, the usage
 * charts and the skill/extension managers. `settings-dialog` is loaded lazily, the
 * first time the route is actually opened; this module is what stays eager.
 */
export type SectionId =
  | "general"
  | "personalization"
  | "shortcuts"
  | "archived"
  | "usage"
  | "providers"
  | "subagents"
  | "mcp"
  | "skills"
  | "extensions"
  | "import"
  | "remote"
  | "about";

export type SettingsGroupId = "preferences" | "workspace" | "integrations" | "system" | "about";

/**
 * Also drives the router's /settings/:section validation.
 *
 * Only ids live here: names are looked up per render (`settingsSectionLabel`), so the
 * pane's nav, its header and the command palette cannot freeze the language the app
 * happened to start in.
 */
export const SETTINGS_SECTIONS: Array<{
  group: SettingsGroupId;
  items: Array<{ id: SectionId; icon: JSX.Element }>;
}> = [
  {
    group: "preferences",
    items: [
      { id: "general", icon: <HugeiconsIcon strokeWidth={2} icon={Settings02Icon} /> },
      { id: "personalization", icon: <HugeiconsIcon strokeWidth={2} icon={SparklesIcon} /> },
      { id: "shortcuts", icon: <HugeiconsIcon strokeWidth={2} icon={KeyboardIcon} /> },
    ],
  },
  {
    group: "workspace",
    items: [
      { id: "archived", icon: <HugeiconsIcon strokeWidth={2} icon={Archive04Icon} /> },
      { id: "usage", icon: <HugeiconsIcon strokeWidth={2} icon={Analytics01Icon} /> },
      { id: "import", icon: <HugeiconsIcon strokeWidth={2} icon={ImportIcon} /> },
    ],
  },
  {
    group: "integrations",
    items: [
      { id: "providers", icon: <HugeiconsIcon strokeWidth={2} icon={BoxesIcon} /> },
      { id: "subagents", icon: <HugeiconsIcon strokeWidth={2} icon={BotIcon} /> },
      { id: "mcp", icon: <HugeiconsIcon strokeWidth={2} icon={Plug01Icon} /> },
      { id: "skills", icon: <HugeiconsIcon strokeWidth={2} icon={SparklesIcon} /> },
      { id: "extensions", icon: <HugeiconsIcon strokeWidth={2} icon={PuzzleIcon} /> },
    ],
  },
  {
    group: "system",
    items: [{ id: "remote", icon: <HugeiconsIcon strokeWidth={2} icon={Wifi01Icon} /> }],
  },
  {
    group: "about",
    items: [{ id: "about", icon: <HugeiconsIcon strokeWidth={2} icon={InformationCircleIcon} /> }],
  },
];

export function settingsSectionLabel(section: SectionId): string {
  return i18n.t(`settings:sections.${section}`) as string;
}

/** Nav heading above a group of panes. */
export function settingsGroupLabel(group: SettingsGroupId): string {
  return i18n.t(`settings:groups.${group}`) as string;
}
