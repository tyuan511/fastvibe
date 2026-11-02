import type { ViviSettings } from "../../shared/vivi.ts";

export type ViviBounds = { x: number; y: number; width: number; height: number };

export const VIVI_BASE_SIZE = 280;
const EDGE_GAP = 24;

export function clampViviBounds(bounds: ViviBounds, workArea: ViviBounds): ViviBounds {
  const size = Math.min(bounds.width, bounds.height, workArea.width, workArea.height);
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - size),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - size),
    width: size,
    height: size,
  };
}

export function viviBoundsFor(settings: ViviSettings, workArea: ViviBounds): ViviBounds {
  const size = Math.round(VIVI_BASE_SIZE * settings.scale);
  const bounds = {
    x: settings.position.includes("right") ? workArea.x + workArea.width - size - EDGE_GAP : workArea.x + EDGE_GAP,
    y: settings.position.includes("bottom") ? workArea.y + workArea.height - size - EDGE_GAP : workArea.y + EDGE_GAP,
    width: size,
    height: size,
  };
  if (settings.position === "custom" && settings.x !== undefined && settings.y !== undefined) {
    bounds.x = settings.x;
    bounds.y = settings.y;
  }
  return clampViviBounds(bounds, workArea);
}
