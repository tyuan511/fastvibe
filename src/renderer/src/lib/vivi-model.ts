import { Object3D, PropertyBinding } from "three";
import type { ViviMood } from "../../../shared/vivi.ts";

export const VIVI_MOODS: readonly ViviMood[] = ["idle", "thinking", "working", "waiting", "success", "error"];

export function viviNode(root: Object3D, name: string): Object3D | undefined {
  // GLTFLoader removes dots from Blender node names before animation binding.
  return root.getObjectByName(PropertyBinding.sanitizeNodeName(name));
}

function requiredNode(root: Object3D, name: string): Object3D {
  const node = viviNode(root, name);
  if (!node) throw new Error(`Vivi model is missing ${name}`);
  return node;
}

export function bindViviVisuals(root: Object3D) {
  const faces = new Map<ViviMood, Object3D[]>();
  for (const mood of VIVI_MOODS) {
    const tag = mood[0].toUpperCase() + mood.slice(1);
    const parts = [
      requiredNode(root, `Face.${tag}`),
      requiredNode(root, `Face.${tag}.Eyes`),
      requiredNode(root, `Mouth.${tag}`),
    ];
    const tongue = viviNode(root, `Tongue.${tag}`);
    if (tongue) parts.push(tongue);
    faces.set(mood, parts);
  }
  return {
    faces,
    sparkle: requiredNode(root, "Sparkle"),
    sparkleOff: requiredNode(root, "SparkleOff"),
    sweat: requiredNode(root, "Sweat"),
    minis: [requiredNode(root, "Mini.A"), requiredNode(root, "Mini.B")],
  };
}

export function showViviMood(visuals: ReturnType<typeof bindViviVisuals>, mood: ViviMood): void {
  for (const [faceMood, parts] of visuals.faces) {
    for (const part of parts) part.visible = faceMood === mood;
  }
  visuals.sparkle.visible = mood !== "error";
  visuals.sparkleOff.visible = mood === "error";
  visuals.sweat.visible = mood === "error";
  for (const mini of visuals.minis) mini.visible = mood === "success";
}
