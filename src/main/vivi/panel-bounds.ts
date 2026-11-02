import type { ViviBounds } from "./bounds.ts";

export type ViviSurfaceLayout = { window: ViviBounds; pet: ViviBounds; bubble?: ViviBounds; composer?: ViviBounds };

export function viviSurfaceLayout(pet: ViviBounds, area: ViviBounds, requestedHeight: number, composerHeight = 0, requestedWidth?: number): ViviSurfaceLayout {
  if (requestedHeight <= 0 && composerHeight <= 0) return { window: { ...pet }, pet: { x: 0, y: 0, width: pet.width, height: pet.height } };
  const defaultWidth = requestedHeight > 120 || composerHeight > 0 ? 360 : 240;
  const gutter = Math.min(14, Math.floor(Math.min(area.width, area.height) / 4));
  const width = Math.min(Math.max(1, Math.ceil(requestedWidth ?? defaultWidth)), area.width - gutter * 2);
  const fullArea = area;
  area = { x: area.x + gutter, y: area.y + gutter, width: area.width - gutter * 2, height: area.height - gutter * 2 };
  const gap = 2;
  const controlsHeight = Math.min(120, Math.max(0, composerHeight));
  const contentHeight = requestedHeight > 0 ? Math.min(Math.max(1, Math.round(requestedHeight)), 460, area.height) : 0;
  const height = Math.min(contentHeight + controlsHeight + (contentHeight && controlsHeight ? gap : 0), area.height);
  const above = pet.y - gap - height;
  const below = pet.y + pet.height + gap;
  let group = {
    x: Math.min(Math.max(pet.x + pet.width / 2 - width / 2, area.x), area.x + area.width - width),
    y: above >= area.y ? above : below + height <= area.y + area.height ? below : area.y,
    width,
    height,
  };
  if (above < area.y && below + height > area.y + area.height) {
    const left = pet.x - gap - width;
    const right = pet.x + pet.width + gap;
    if (left >= area.x || right + width <= area.x + area.width) {
      group.x = left >= area.x ? left : right;
      group.y = Math.min(Math.max(pet.y + pet.height / 2 - height / 2, area.y), area.y + area.height - height);
    } else {
      const topSpace = pet.y - area.y - gap;
      const bottomSpace = area.y + area.height - pet.y - pet.height - gap;
      group.height = Math.max(0, Math.max(topSpace, bottomSpace));
      group.y = topSpace >= bottomSpace ? area.y : below;
    }
  }
  group = { ...group, x: Math.round(group.x), y: Math.round(group.y) };
  const separateControls = contentHeight > 0 && controlsHeight > 0 && pet.y + pet.height + gap + controlsHeight <= area.y + area.height && group.y + group.height <= pet.y;
  if (separateControls) group.height = Math.max(0, group.height - controlsHeight - (contentHeight ? gap : 0));
  const composer = controlsHeight > 0 ? {
    x: group.x,
    y: separateControls || (contentHeight === 0 && below + controlsHeight <= area.y + area.height) ? below : group.y + Math.max(0, group.height - controlsHeight),
    width,
    height: Math.min(controlsHeight, separateControls ? controlsHeight : group.height),
  } : undefined;
  const bubble = contentHeight > 0 ? { ...group, height: Math.max(0, group.height - (composer && !separateControls ? composer.height + gap : 0)) } : undefined;
  const rectangles = [pet, ...(bubble ? [{ x: bubble.x - gutter, y: bubble.y - gutter, width: bubble.width + gutter * 2, height: bubble.height + gutter * 2 }] : []), ...(composer ? [composer] : [])];
  const x = Math.max(fullArea.x, Math.min(...rectangles.map((rect) => rect.x)));
  const y = Math.max(fullArea.y, Math.min(...rectangles.map((rect) => rect.y)));
  const window = { x, y, width: Math.min(fullArea.x + fullArea.width, Math.max(...rectangles.map((rect) => rect.x + rect.width))) - x, height: Math.min(fullArea.y + fullArea.height, Math.max(...rectangles.map((rect) => rect.y + rect.height))) - y };
  const relative = (rect: ViviBounds): ViviBounds => ({ ...rect, x: rect.x - x, y: rect.y - y });
  return { window, pet: relative(pet), ...(bubble ? { bubble: relative(bubble) } : {}), ...(composer ? { composer: relative(composer) } : {}) };
}
