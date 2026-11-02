import {
  normalizeViviSettings,
  viviSettingsPatch,
  type ViviActor,
  type ViviMood,
  type ViviSettings,
  type ViviSnapshot,
  type ViviState,
} from "../../shared/vivi.ts";

/** One character is projected into both the desktop renderer and its settings pane. */
export class ViviStateStore {
  #settings: ViviSettings;
  #mood: ViviMood = "idle";
  #conversationId: string | undefined;
  #visible = false;

  constructor(settings: Record<string, unknown>) {
    this.#settings = normalizeViviSettings(settings);
  }

  settings(): ViviSettings { return { ...this.#settings }; }

  patchSettings(patch: Partial<ViviSettings>): ViviSettings {
    const next = { ...this.#settings, ...patch };
    return normalizeViviSettings(viviSettingsPatch(next));
  }

  applySettings(settings: ViviSettings): void {
    this.#settings = normalizeViviSettings(viviSettingsPatch(settings));
  }

  setVisible(visible: boolean): void { this.#visible = visible; }

  setMood(mood: ViviMood, conversationId?: string): void {
    this.#mood = mood;
    this.#conversationId = conversationId;
  }

  follow(actors: readonly ViviActor[]): void {
    const actor = actors.find((item) => item.mood === "waiting") ?? actors[0];
    this.setMood(actor?.mood ?? "idle", actor?.conversationId);
  }

  state(): ViviState {
    return {
      mood: this.#mood,
      palette: this.#settings.palette,
      visible: this.#visible,
      x: this.#settings.x ?? 0,
      y: this.#settings.y ?? 0,
      scale: this.#settings.scale,
      opacity: this.#settings.opacity,
      ...(this.#conversationId ? { conversationId: this.#conversationId } : {}),
    };
  }

  snapshot(): ViviSnapshot {
    return {
      settings: this.settings(),
      visible: this.#visible,
      actors: [{
        id: "vivi",
        label: "Vivi",
        mood: this.#mood,
        palette: this.#settings.palette,
        ...(this.#conversationId ? { conversationId: this.#conversationId } : {}),
      }],
    };
  }
}
