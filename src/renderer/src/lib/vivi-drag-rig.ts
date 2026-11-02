import { Euler, Group, Quaternion, Vector3 } from "three";
import { viviNode } from "./vivi-model.ts";
import type { ViviDragPose } from "./vivi-drag-physics.ts";
import type { ViviActivityPose } from "./vivi-activity-motion.ts";

export function createViviDragRig(root: Group, pivotPoint: Vector3, height: number) {
  const pivot = new Group();
  const offset = new Group();
  pivot.name = "ViviDragPivot";
  offset.position.copy(pivotPoint).negate();
  for (const child of [...root.children]) offset.add(child);
  pivot.add(offset);
  root.add(pivot);
  pivot.position.copy(pivotPoint);

  const feet = ["foot.L", "foot.R"].map((name) => {
    const node = viviNode(root, name);
    if (!node) throw new Error(`Vivi model is missing ${name}`);
    return { node, position: node.position.clone(), quaternion: node.quaternion.clone(), applied: false };
  });
  const headNode = viviNode(root, "head");
  if (!headNode) throw new Error("Vivi model is missing head");
  const head = { node: headNode, quaternion: headNode.quaternion.clone(), applied: false };
  const activityPivot = new Group();
  const activityOffset = new Group();
  activityPivot.name = "ViviActivityPivot";
  activityOffset.position.copy(pivotPoint).negate();
  for (const child of [...offset.children]) activityOffset.add(child);
  activityPivot.add(activityOffset);
  offset.add(activityPivot);
  activityPivot.position.copy(pivotPoint);
  const idleEyes = ["L", "R"].map((side) => {
    const eye = viviNode(root, `Eye.${side}.Idle`);
    if (!eye) throw new Error(`Vivi model is missing Eye.${side}.Idle`);
    return [eye, viviNode(root, `Eye.${side}.Idle.Shine0`), viviNode(root, `Eye.${side}.Idle.Shine1`)]
      .filter((node): node is NonNullable<typeof node> => Boolean(node))
      .map((node) => ({ node, center: eye.position.y, position: node.position.clone(), scale: node.scale.clone() }));
  });
  const idleMouth = viviNode(root, "Mouth.Idle");
  const mouthTemplate = viviNode(root, "Mouth.Waiting");
  if (!idleMouth || !mouthTemplate) throw new Error("Vivi model is missing idle mouth");
  const mouth = { node: idleMouth, scale: idleMouth.scale.clone() };
  const openMouth = mouthTemplate.clone();
  openMouth.name = "ViviClickMouth";
  openMouth.visible = false;
  mouthTemplate.parent!.add(openMouth);
  const openScale = openMouth.scale.clone();
  const rotation = new Euler(0, 0, 0, "YXZ");
  const kick = new Quaternion();

  function restore(): void {
    for (const eye of idleEyes.flat()) {
      eye.node.position.copy(eye.position);
      eye.node.scale.copy(eye.scale);
    }
    mouth.node.scale.copy(mouth.scale);
    openMouth.visible = false;
    if (head.applied) {
      head.node.quaternion.copy(head.quaternion);
      head.applied = false;
    }
    for (const foot of feet) {
      if (!foot.applied) continue;
      foot.node.position.copy(foot.position);
      foot.node.quaternion.copy(foot.quaternion);
      foot.applied = false;
    }
  }

  function apply(pose: ViviDragPose, activity?: ViviActivityPose): void {
    idleEyes.forEach((parts, side) => {
      const blink = side === 0 ? activity?.leftBlink ?? 0 : activity?.rightBlink ?? 0;
      const openness = Math.max(0.035, 1 - blink);
      for (const eye of parts) {
        eye.node.scale.y = eye.scale.y * openness;
        eye.node.position.y = eye.center + (eye.position.y - eye.center) * openness;
      }
    });
    const opening = mouth.node.visible ? activity?.mouthOpen ?? 0 : 0;
    mouth.node.scale.copy(mouth.scale);
    mouth.node.scale.multiplyScalar(opening > 0.12 ? 0.001 : 1);
    openMouth.visible = opening > 0.12;
    openMouth.scale.copy(openScale);
    openMouth.scale.x *= 1 + opening * 0.2;
    openMouth.scale.y *= 0.3 + opening * 0.7;
    openMouth.scale.z *= 0.2 + opening * 0.9;
    activityPivot.position.copy(pivotPoint);
    activityPivot.position.x += (activity?.offsetX ?? 0) * height;
    activityPivot.position.y += (activity?.offsetY ?? 0) * height;
    activityPivot.position.z += (activity?.offsetZ ?? 0) * height;
    activityPivot.quaternion.setFromEuler(rotation.set(activity?.pitch ?? 0, activity?.yaw ?? 0, activity?.roll ?? 0, "YXZ"));
    const activityStretch = 1 + (activity?.stretch ?? 0);
    const activitySide = 1 / Math.sqrt(activityStretch);
    activityPivot.scale.set(activitySide, activityStretch, activitySide);
    head.quaternion.copy(head.node.quaternion);
    head.node.quaternion.multiply(kick.setFromEuler(rotation.set(activity?.headPitch ?? 0, activity?.headYaw ?? 0, activity?.headRoll ?? 0, "YXZ")));
    head.applied = true;
    pivot.position.copy(pivotPoint);
    pivot.position.x += pose.offsetX * height;
    pivot.position.y += pose.offsetY * height;
    pivot.quaternion.setFromEuler(rotation.set(pose.pitch, pose.yaw, pose.roll, "YXZ"));
    const stretch = 1 + pose.stretch;
    const side = 1 / Math.sqrt(stretch);
    pivot.scale.set(side * pose.squashX, stretch * pose.squashY, side);
    feet.forEach((foot, index) => {
      const motion = index === 0 ? pose.leftFoot : pose.rightFoot;
      const acting = index === 0 ? activity?.leftFoot : activity?.rightFoot;
      foot.position.copy(foot.node.position);
      foot.quaternion.copy(foot.node.quaternion);
      foot.node.quaternion.multiply(kick.setFromEuler(rotation.set(
        motion.pitch + (acting?.pitch ?? 0),
        motion.yaw + (acting?.yaw ?? 0),
        motion.roll + (acting?.roll ?? 0),
        "XYZ",
      )));
      foot.node.position.y += (motion.lift + (acting?.lift ?? 0)) * height;
      foot.applied = true;
    });
  }

  return { restore, apply };
}
