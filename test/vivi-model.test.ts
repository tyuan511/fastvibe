import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AnimationMixer, Box3, Object3D, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { bindViviVisuals, showViviMood, viviNode, VIVI_MOODS } from "../src/renderer/src/lib/vivi-model.ts";
import { createViviDragRig } from "../src/renderer/src/lib/vivi-drag-rig.ts";
import { ViviDragPhysics } from "../src/renderer/src/lib/vivi-drag-physics.ts";
import { ViviActivityMotion, VIVI_GESTURES, type ViviGesture } from "../src/renderer/src/lib/vivi-activity-motion.ts";

async function loadVivi() {
  const bytes = readFileSync(new URL("../resources/vivi/vivi.glb", import.meta.url));
  return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
}

function visibleInTree(node: Object3D): boolean {
  for (let current: Object3D | null = node; current; current = current.parent) {
    if (!current.visible) return false;
  }
  return true;
}

test("the shipped GLB displays only the selected face throughout all six animations", async () => {
  const { scene, animations } = await loadVivi();
  const visuals = bindViviVisuals(scene);
  const mixer = new AnimationMixer(scene);
  for (const mood of VIVI_MOODS) {
    const clip = animations.find((item) => item.name === mood);
    assert.ok(clip, `${mood} clip must exist`);
    mixer.stopAllAction();
    mixer.clipAction(clip).play();
    showViviMood(visuals, mood);
    for (const time of [0, clip.duration / 2, clip.duration * 0.95]) {
      mixer.setTime(time);
      for (const [faceMood, parts] of visuals.faces) {
        assert.ok(parts.length >= 3, `${faceMood} has face, eyes and mouth`);
        for (const node of parts) assert.equal(visibleInTree(node), faceMood === mood, `${node.name} during ${mood} at ${time}`);
      }
      assert.equal(visibleInTree(visuals.sparkle), mood !== "error");
      assert.equal(visibleInTree(visuals.sparkleOff), mood === "error");
      assert.equal(visibleInTree(visuals.sweat), mood === "error");
      for (const mini of visuals.minis) assert.equal(visibleInTree(mini), mood === "success");
    }
  }
  assert.ok(viviNode(scene, "Foot.L"));
  assert.ok(viviNode(scene, "Foot.R"));
});

test("cloned Vivi actors keep their facial states separate", async () => {
  const { scene } = await loadVivi();
  const first = bindViviVisuals(clone(scene));
  const second = bindViviVisuals(clone(scene));
  showViviMood(first, "waiting");
  showViviMood(second, "error");
  assert.equal(visibleInTree(first.faces.get("waiting")![1]!), true);
  assert.equal(visibleInTree(first.faces.get("error")![1]!), false);
  assert.equal(visibleInTree(second.faces.get("waiting")![1]!), false);
  assert.equal(visibleInTree(second.faces.get("error")![1]!), true);
});

test("a renamed or missing face fails visibly instead of rendering every mood at once", async () => {
  const { scene } = await loadVivi();
  viviNode(scene, "Face.Idle.Eyes")!.name = "unrecognized";
  assert.throws(() => bindViviVisuals(scene), /Face.Idle.Eyes/);
});

test("dragging deforms the shipped skeleton without accumulating or corrupting mood animation", async () => {
  const { scene, animations } = await loadVivi();
  const bounds = new Box3().setFromObject(scene);
  const pivot = bounds.getCenter(new Vector3());
  const height = bounds.max.y - bounds.min.y;
  const before = bounds.clone();
  const rig = createViviDragRig(scene, pivot, height);
  scene.updateWorldMatrix(true, true);
  const after = new Box3().setFromObject(scene);
  assert.ok(before.min.distanceTo(after.min) < 1e-6);
  assert.ok(before.max.distanceTo(after.max) < 1e-6);
  const visuals = bindViviVisuals(scene);
  const mixer = new AnimationMixer(scene);
  const physics = new ViviDragPhysics();
  physics.sample({ dragging: true, x: 0, y: 0, size: 140, at: 0 });
  for (let frame = 1; frame <= 30; frame++) {
    physics.sample({ dragging: true, x: frame * 7, y: -frame, size: 140, at: frame * 1000 / 60 });
    physics.step(1 / 60);
  }
  const pose = physics.step(0);
  const left = viviNode(scene, "foot.L")!;
  const right = viviNode(scene, "foot.R")!;
  const skinned = scene.getObjectByName("Body") as Object3D & { skeleton: { bones: Object3D[] } };
  assert.ok(skinned.skeleton.bones.includes(left));
  assert.ok(skinned.skeleton.bones.includes(right));
  for (const clip of animations) {
    rig.restore();
    mixer.stopAllAction();
    mixer.clipAction(clip).play();
    showViviMood(visuals, clip.name as typeof VIVI_MOODS[number]);
    for (let frame = 0; frame < 120; frame++) {
      rig.restore();
      mixer.update(1 / 60);
      const position = left.position.clone();
      const rotation = left.quaternion.clone();
      const rightRotation = right.quaternion.clone();
      const rootRotation = viviNode(scene, "root")!.quaternion.clone();
      rig.apply(pose);
      assert.ok(left.quaternion.angleTo(rotation) > 0.05);
      assert.ok(right.quaternion.angleTo(rightRotation) > 0.05);
      scene.updateWorldMatrix(true, true);
      assert.ok(scene.getObjectByName("ViviDragPivot")!.quaternion.angleTo(rootRotation) > 0.05);
      for (const [mood, parts] of visuals.faces) {
        for (const node of parts) assert.equal(visibleInTree(node), mood === clip.name);
      }
      rig.restore();
      assert.ok(left.position.distanceTo(position) < 1e-8);
      assert.ok(left.quaternion.angleTo(rotation) < 1e-6);
      assert.ok(right.quaternion.angleTo(rightRotation) < 1e-6);
      assert.ok(viviNode(scene, "root")!.quaternion.angleTo(rootRotation) < 1e-6);
    }
  }
  physics.reset();
  rig.apply(physics.step(0));
  const dragPivot = scene.getObjectByName("ViviDragPivot")!;
  assert.ok(dragPivot.position.distanceTo(pivot) < 1e-8);
  assert.ok(dragPivot.rotation.toArray().slice(0, 3).every((value) => value === 0));
  assert.deepEqual(dragPivot.scale.toArray(), [1, 1, 1]);
  for (const impact of [{ x: -1, y: 0, speed: 1800 }, { x: 0, y: 1, speed: 1800 }]) {
    physics.sample({ dragging: false, x: 0, y: 0, size: 140, at: 1000 + impact.y, impact });
    const collision = physics.step(1 / 120);
    rig.restore();
    rig.apply(collision);
    if (impact.x) assert.ok(dragPivot.scale.x < dragPivot.scale.y);
    if (impact.y) assert.ok(dragPivot.scale.y < dragPivot.scale.x);
    scene.updateWorldMatrix(true, true);
    const bodyBounds = new Box3().setFromObject(scene);
    assert.ok(bodyBounds.min.toArray().every(Number.isFinite));
    assert.ok(bodyBounds.max.toArray().every(Number.isFinite));
  }
});

test("idle clicks blink the real eye meshes, open a mouth and restore the neutral face", async () => {
  const { scene } = await loadVivi();
  const bounds = new Box3().setFromObject(scene);
  const rig = createViviDragRig(scene, bounds.getCenter(new Vector3()), bounds.max.y - bounds.min.y);
  const visuals = bindViviVisuals(scene);
  showViviMood(visuals, "idle");
  const activity = new ViviActivityMotion("idle", () => 0.4);
  const rest = new ViviDragPhysics().step(0);
  const eye = viviNode(scene, "Eye.L.Idle")!;
  const neutralScale = eye.scale.clone();
  const neutralPosition = eye.position.clone();
  let smallest = 1;
  activity.triggerNext();
  for (let frame = 0; frame < 45; frame++) {
    rig.restore();
    const pose = activity.step(1 / 60);
    rig.apply(rest, pose);
    smallest = Math.min(smallest, eye.scale.y / neutralScale.y);
    assert.ok(eye.position.distanceTo(neutralPosition) < 1e-8);
  }
  assert.ok(smallest < 0.15);
  for (let click = 0; click < 3; click++) activity.triggerNext();
  let opened = false;
  for (let frame = 0; frame < 65; frame++) {
    rig.restore();
    const pose = activity.step(1 / 60);
    rig.apply(rest, pose);
    if (pose.mouthOpen > 0.5) {
      assert.equal(scene.getObjectByName("ViviClickMouth")!.visible, true);
      assert.ok(viviNode(scene, "Mouth.Idle")!.scale.length() < 0.01);
      opened = true;
    }
  }
  assert.ok(opened);
  rig.restore();
  assert.deepEqual(eye.scale.toArray(), neutralScale.toArray());
  assert.equal(scene.getObjectByName("ViviClickMouth")!.visible, false);
  showViviMood(visuals, "working");
  rig.apply(rest, activity.step(0));
  assert.equal(scene.getObjectByName("ViviClickMouth")!.visible, false);
});

test("autonomous gestures move the real body, head and feet while preserving all mood clips", async () => {
  const { scene, animations } = await loadVivi();
  const bounds = new Box3().setFromObject(scene);
  const height = bounds.max.y - bounds.min.y;
  const rig = createViviDragRig(scene, bounds.getCenter(new Vector3()), height);
  const mixer = new AnimationMixer(scene);
  const visuals = bindViviVisuals(scene);
  const rest = new ViviDragPhysics().step(0);
  const bones = ["head", "foot.L", "foot.R", "root"].map((name) => viviNode(scene, name)!);
  const activityPivot = scene.getObjectByName("ViviActivityPivot")!;
  const before = new Vector3();
  const after = new Vector3();
  for (const mood of VIVI_MOODS) {
    rig.restore();
    mixer.stopAllAction();
    mixer.clipAction(animations.find((clip) => clip.name === mood)!).play();
    showViviMood(visuals, mood);
    const activity = new ViviActivityMotion(mood, () => 0.4);
    const seen = new Set<ViviGesture>();
    let maxHeadChange = 0;
    let maxTurn = 0;
    for (let frame = 0; frame < 50 * 30; frame++) {
      rig.restore();
      mixer.update(1 / 30);
      const original = bones.map((bone) => ({ position: bone.position.clone(), rotation: bone.quaternion.clone() }));
      bones[0].getWorldPosition(before);
      const pose = activity.step(1 / 30);
      if (pose.gesture) seen.add(pose.gesture);
      rig.apply(rest, pose);
      bones[0].getWorldPosition(after);
      assert.ok(Number.isFinite(after.x + after.y + after.z));
      maxHeadChange = Math.max(maxHeadChange, bones[0].quaternion.angleTo(original[0].rotation));
      maxTurn = Math.max(maxTurn, Math.abs(pose.yaw));
      assert.ok(before.distanceTo(after) < height * 0.4);
      assert.ok(activityPivot.scale.y > 0.9 && activityPivot.scale.y < 1.15);
      for (const [faceMood, parts] of visuals.faces) {
        for (const node of parts) assert.equal(visibleInTree(node), faceMood === mood);
      }
      rig.restore();
      bones.forEach((bone, index) => {
        assert.ok(bone.position.distanceTo(original[index].position) < 1e-8);
        assert.ok(bone.quaternion.angleTo(original[index].rotation) < 1e-6);
      });
    }
    assert.deepEqual(seen, new Set(VIVI_GESTURES[mood]));
    assert.ok(maxHeadChange > 0.03 && maxTurn > 0.5);
    for (let frame = 0; frame < 120; frame++) {
      rig.restore();
      mixer.update(1 / 60);
      rig.apply(rest, activity.step(1 / 60, true));
    }
    assert.ok(activityPivot.position.distanceTo(bounds.getCenter(new Vector3())) < 0.00001);
    assert.ok(Math.abs(activityPivot.rotation.y) < 0.00001);
  }
});
