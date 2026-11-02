import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { ViviDragMotion, ViviMood, ViviPalette } from "@shared/vivi";
import { VIVI_PALETTES } from "@shared/vivi";
import { bindViviVisuals, showViviMood, viviNode, VIVI_MOODS } from "./vivi-model";
import { ViviDragPhysics } from "./vivi-drag-physics";
import { createViviDragRig } from "./vivi-drag-rig";
import { ViviActivityMotion } from "./vivi-activity-motion";

const MODEL_URL = "vivi-resource://model/vivi.glb";
const BLUSH = new THREE.Color("#ff86c4");
const MIDPOINT = 0.42;
const MOODS = VIVI_MOODS;
const DPR_CAP = 2;
const IDLE_FRAME_MS = 1000 / 30;
const ACTIVE_FRAME_MS = 1000 / 60;
const TRANSITION_SECONDS = 0.24;

export interface ViviActor {
  id: string;
  label: string;
  mood: ViviMood;
  palette: ViviPalette;
  conversationId?: string;
}

export interface ViviScene {
  setActors(actors: readonly ViviActor[]): void;
  setVisible(visible: boolean): void;
  prepareFrame(): void;
  setClickable(clickable: boolean): void;
  setDragMotion(motion: ViviDragMotion): void;
  hitTest(clientX: number, clientY: number): string | null;
  getActorScreenPosition(actorId: string): { x: number; y: number } | null;
  poke(actorId: string): void;
  cleanup(): void;
}

type ViviMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
type ViviActionMap = Partial<Record<ViviMood, THREE.AnimationAction>>;

type ActorInstance = {
  actor: ViviActor;
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  dragRig: ReturnType<typeof createViviDragRig>;
  activity: ViviActivityMotion;
  actions: ViviActionMap;
  mood: ViviMood;
  palette: ViviPalette;
  visuals: ReturnType<typeof bindViviVisuals>;
  bodyColor: THREE.BufferAttribute | undefined;
  bodyShade: THREE.BufferAttribute | undefined;
  ownedGeometries: Set<THREE.BufferGeometry>;
  ownedMaterials: Set<THREE.Material>;
  hitMeshes: ViviMesh[];
  labelPoint: THREE.Vector3;
};

function isMesh(object: THREE.Object3D): object is ViviMesh {
  return object instanceof THREE.Mesh;
}

function materialsOf(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(material)) {
    if (value && typeof value === "object" && "isTexture" in value && value instanceof THREE.Texture) {
      value.dispose();
    }
  }
  material.dispose();
}

function setMaterialColor(material: THREE.Material, color: string): void {
  const colorMaterial = material as THREE.Material & { color?: THREE.Color };
  colorMaterial.color?.set(color);
  material.needsUpdate = true;
}

function lerpPalette(stops: readonly string[], value: number, output: THREE.Color): THREE.Color {
  const amount = THREE.MathUtils.clamp(value, 0, 1);
  const first = new THREE.Color(stops[0]);
  const second = new THREE.Color(stops[1]);
  const third = new THREE.Color(stops[2]);
  if (amount <= MIDPOINT) return output.copy(first).lerp(second, amount / MIDPOINT);
  return output.copy(second).lerp(third, (amount - MIDPOINT) / (1 - MIDPOINT));
}

function visibleInHierarchy(object: THREE.Object3D, root: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current && current !== root) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return root.visible && (!current || current === root);
}

function copyActor(actor: ViviActor): ViviActor {
  return {
    id: actor.id,
    label: actor.label,
    mood: MOODS.includes(actor.mood) ? actor.mood : "idle",
    palette: actor.palette in VIVI_PALETTES ? actor.palette : "sky",
    ...(actor.conversationId === undefined ? {} : { conversationId: actor.conversationId }),
  };
}

function cloneBodyGeometry(source: THREE.BufferGeometry): {
  geometry: THREE.BufferGeometry;
  shade: THREE.BufferAttribute | undefined;
  color: THREE.BufferAttribute | undefined;
} {
  // SkeletonUtils shares geometry between clones. Keep every immutable attribute shared,
  // and give the actor only its own vertex-color buffer so palette updates cannot leak.
  const geometry = source.clone();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    if (name !== "color") geometry.setAttribute(name, attribute);
  }
  geometry.setIndex(source.index);
  const shade = source.getAttribute("color") as THREE.BufferAttribute | undefined;
  const color = shade ? new THREE.BufferAttribute(new Float32Array(shade.count * 3), 3) : undefined;
  if (color) geometry.setAttribute("color", color);
  return { geometry, shade, color };
}

function clonedFootMaterial(source: THREE.Material | THREE.Material[], color: string, owned: Set<THREE.Material>): THREE.Material | THREE.Material[] {
  const cloneOne = (material: THREE.Material): THREE.Material => {
    const copy = material.clone();
    setMaterialColor(copy, color);
    owned.add(copy);
    return copy;
  };
  return Array.isArray(source) ? source.map(cloneOne) : cloneOne(source);
}

/**
 * Create the transparent, single-canvas Vivi scene.
 *
 * The GLB is loaded exactly once. Every actor gets a SkeletonUtils clone, its own
 * AnimationMixer, body color buffer, body material, and feet materials while all other
 * geometry and materials remain shared with the loaded asset.
 */
export async function initializeViviScene(canvas: HTMLCanvasElement, onMotionSettled?: (at: number) => void): Promise<ViviScene> {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.setClearColor(0, 0);
  renderer.setClearAlpha(0);

  const scene = new THREE.Scene();
  const world = new THREE.Group();
  scene.add(world);

  const environmentRoom = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(environmentRoom, 0.04, 0.1, 100, { size: 128 });
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.4;
  environmentRoom.dispose();
  pmrem.dispose();

  const key = new THREE.DirectionalLight("#fff7f1", 2.2);
  key.position.set(-3.5, 4.5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight("#f2f7ff", 0.5);
  fill.position.set(3, 1, 5);
  scene.add(fill);
  const rim = new THREE.DirectionalLight("#dce8ff", 1);
  rim.position.set(3, 3, -4);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight("#f5f8ff", "#cbd9f0", 0.95));

  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  camera.position.set(0, 0.75, 4.5);

  const loader = new GLTFLoader();
  let gltf: Awaited<ReturnType<GLTFLoader["loadAsync"]>>;
  try {
    gltf = await loader.loadAsync(MODEL_URL);
  } catch (error) {
    environment.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
  const source = gltf.scene;
  source.updateWorldMatrix(true, true);

  const sourceBounds = new THREE.Box3().setFromObject(source);
  const sourceSize = sourceBounds.getSize(new THREE.Vector3());
  const sourceCenter = sourceBounds.getCenter(new THREE.Vector3());
  const sourceBody = source.getObjectByName("Body");
  const sourceGeometries = new Set<THREE.BufferGeometry>();
  const sourceMaterials = new Set<THREE.Material>();
  const sourceTextures = new Set<THREE.Texture>();
  source.traverse((object) => {
    if (!isMesh(object)) return;
    sourceGeometries.add(object.geometry);
    for (const material of materialsOf(object.material)) {
      sourceMaterials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) sourceTextures.add(value);
      }
    }
  });

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const actors = new Map<string, ActorInstance>();
  const interactiveMeshes: ViviMesh[] = [];
  const clock = new THREE.Clock();
  const paletteColor = new THREE.Color();
  const dragPhysics = new ViviDragPhysics();
  let dragActive = false;
  let clickable = true;
  let visible = false;
  let alive = true;
  let animationFrame: number | undefined;
  let lastRenderTime = -Infinity;
  let activeUntil = 0;
  let pendingMotion: ViviDragMotion | undefined;
  let settledSince: number | undefined;
  let canvasSize = "";

  function applyPalette(instance: ActorInstance, paletteId: ViviPalette): void {
    const palette = VIVI_PALETTES[paletteId] ?? VIVI_PALETTES.sky;
    const shade = instance.bodyShade;
    const color = instance.bodyColor;
    if (shade && color) {
      for (let index = 0; index < shade.count; index += 1) {
        lerpPalette(palette.stops, shade.getX(index), paletteColor);
        paletteColor.lerp(BLUSH, THREE.MathUtils.clamp(shade.itemSize > 1 ? shade.getY(index) : 0, 0, 1) * 0.5);
        color.setXYZ(index, paletteColor.r, paletteColor.g, paletteColor.b);
      }
      color.needsUpdate = true;
    }
    for (const footName of ["Foot.L", "Foot.R"]) {
      const foot = viviNode(instance.root, footName);
      if (!foot || !isMesh(foot)) continue;
      for (const material of materialsOf(foot.material)) setMaterialColor(material, palette.feet);
    }
    instance.palette = paletteId;
  }

  function setFace(instance: ActorInstance, mood: ViviMood): void {
    showViviMood(instance.visuals, mood);
  }

  function setMood(instance: ActorInstance, mood: ViviMood, immediate = false): void {
    const next = instance.actions[mood];
    const previous = instance.actions[instance.mood];
    for (const action of Object.values(instance.actions)) {
      if (action !== previous && action !== next) action.stop();
    }
    if (next) {
      next.stopFading().stopWarping().reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
      if (previous && previous !== next) {
        if (immediate) previous.stop();
        else previous.stopFading().setEffectiveWeight(1).crossFadeTo(next, TRANSITION_SECONDS, false);
      }
    }
    instance.mood = mood;
    instance.activity.setMood(mood);
    setFace(instance, mood);
    if (mood !== "idle") activeUntil = performance.now() + 500;
  }

  function createInstance(actorInput: ViviActor): ActorInstance {
    const actor = copyActor(actorInput);
    const root = cloneSkeleton(source) as THREE.Group;
    root.name = `ViviActor:${actor.id}`;
    root.traverse((object) => {
      if (isMesh(object)) {
        object.frustumCulled = false;
        object.castShadow = false;
        object.receiveShadow = false;
      }
    });

    const ownedGeometries = new Set<THREE.BufferGeometry>();
    const ownedMaterials = new Set<THREE.Material>();
    let bodyColor: THREE.BufferAttribute | undefined;
    let bodyShade: THREE.BufferAttribute | undefined;
    const body = root.getObjectByName("Body");
    if (body && isMesh(body) && sourceBody && isMesh(sourceBody)) {
      const cloned = cloneBodyGeometry(sourceBody.geometry);
      body.geometry = cloned.geometry;
      ownedGeometries.add(cloned.geometry);
      bodyColor = cloned.color;
      bodyShade = cloned.shade;
      const bodyMaterial = new THREE.MeshPhysicalMaterial({
        color: "#ffffff",
        vertexColors: Boolean(bodyColor),
        roughness: 0.32,
        metalness: 0,
        clearcoat: 0.3,
        clearcoatRoughness: 0.22,
        sheen: 0.3,
        sheenColor: "#d4e8ff",
        sheenRoughness: 0.55,
      });
      ownedMaterials.add(bodyMaterial);
      body.material = bodyMaterial;
    }

    for (const footName of ["Foot.L", "Foot.R"]) {
      const foot = viviNode(root, footName);
      if (!foot || !isMesh(foot)) continue;
      foot.material = clonedFootMaterial(foot.material, VIVI_PALETTES[actor.palette].feet, ownedMaterials);
    }

    const visuals = bindViviVisuals(root);
    const pivot = new THREE.Vector3(sourceCenter.x, sourceBounds.min.y + sourceSize.y * 0.56, sourceCenter.z);
    const dragRig = createViviDragRig(root, pivot, sourceSize.y);
    const actions: ViviActionMap = {};
    const mixer = new THREE.AnimationMixer(root);
    for (const clip of gltf.animations) {
      const mood = clip.name.toLowerCase() as ViviMood;
      if (!MOODS.includes(mood)) continue;
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      actions[mood] = action;
    }

    const instance: ActorInstance = {
      actor,
      root,
      mixer,
      dragRig,
      activity: new ViviActivityMotion(actor.mood),
      actions,
      mood: "idle",
      palette: actor.palette,
      visuals,
      bodyColor,
      bodyShade,
      ownedGeometries,
      ownedMaterials,
      hitMeshes: [],
      labelPoint: new THREE.Vector3(0, sourceBounds.max.y + 0.16, 0),
    };
    root.traverse((object) => {
      if (isMesh(object)) instance.hitMeshes.push(object);
    });
    world.add(root);
    applyPalette(instance, actor.palette);
    setMood(instance, actor.mood, true);
    return instance;
  }

  function disposeInstance(instance: ActorInstance): void {
    instance.mixer.stopAllAction();
    world.remove(instance.root);
    for (const geometry of instance.ownedGeometries) geometry.dispose();
    for (const material of instance.ownedMaterials) disposeMaterial(material);
  }

  function layout(): void {
    const count = actors.size;
    if (count === 0) {
      world.visible = false;
      return;
    }
    world.visible = visible;
    const gap = sourceSize.x + 0.18;
    const totalUnscaledWidth = sourceSize.x + Math.max(0, count - 1) * gap;
    const actorScale = THREE.MathUtils.clamp(3.25 / totalUnscaledWidth, 0.42, 1);
    const targetY = sourceCenter.y * actorScale;
    let index = 0;
    for (const instance of actors.values()) {
      instance.root.scale.setScalar(actorScale);
      instance.root.position.set((index - (count - 1) / 2) * gap * actorScale, 0, 0);
      index += 1;
    }

    const rect = canvas.getBoundingClientRect();
    const aspect = Math.max(rect.width / Math.max(rect.height, 1), 0.1);
    camera.aspect = aspect;
    camera.fov = 30;
    const verticalHalfAngle = THREE.MathUtils.degToRad(camera.fov / 2);
    const width = totalUnscaledWidth * actorScale;
    const height = sourceSize.y * actorScale;
    const distanceForHeight = height / 2 / Math.tan(verticalHalfAngle);
    const distanceForWidth = width / 2 / (Math.tan(verticalHalfAngle) * aspect);
    camera.position.set(0, targetY, Math.max(3.1, distanceForHeight, distanceForWidth) + 1.05);
    camera.lookAt(0, targetY, 0);
    camera.updateProjectionMatrix();
    world.updateWorldMatrix(true, true);
  }

  function resize(): void {
    const width = Math.max(1, canvas.clientWidth || canvas.getBoundingClientRect().width || 1);
    const height = Math.max(1, canvas.clientHeight || canvas.getBoundingClientRect().height || 1);
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const size = `${width}:${height}:${dpr}`;
    if (size === canvasSize) return;
    canvasSize = size;
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    layout();
    if (visible && !document.hidden) renderer.render(scene, camera);
  }

  function renderFrame(now: number): void {
    if (!alive || !visible || document.hidden) return;
    const active = dragActive || now < activeUntil || [...actors.values()].some((instance) => instance.mood !== "idle" || instance.activity.active);
    const interval = active ? ACTIVE_FRAME_MS : IDLE_FRAME_MS;
    if (now - lastRenderTime >= interval) {
      const delta = Math.min(clock.getDelta(), 0.1);
      const dragPose = dragPhysics.step(delta);
      dragActive = dragPose.active;
      for (const instance of actors.values()) {
        instance.dragRig.restore();
        instance.mixer.update(delta);
        instance.dragRig.apply(dragPose, instance.activity.step(delta, dragPose.active));
      }
      renderer.render(scene, camera);
      if (pendingMotion && !pendingMotion.dragging && !pendingMotion.flying && !dragPose.active) {
        settledSince ??= now;
        if (now - settledSince >= 120) {
          const at = pendingMotion.at;
          pendingMotion = undefined;
          onMotionSettled?.(at);
        }
      } else settledSince = undefined;
      lastRenderTime = now;
    }
    animationFrame = requestAnimationFrame(renderFrame);
  }

  function startLoop(): void {
    if (!alive || !visible || document.hidden || animationFrame !== undefined) return;
    clock.start();
    lastRenderTime = -Infinity;
    animationFrame = requestAnimationFrame(renderFrame);
  }

  function stopLoop(): void {
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    animationFrame = undefined;
  }

  function hitTest(clientX: number, clientY: number): string | null {
    if (!alive || !visible || !clickable || actors.size === 0) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(interactiveMeshes, false);
    for (const hit of hits) {
      const instance = [...actors.values()].find((candidate) => candidate.hitMeshes.includes(hit.object as ViviMesh));
      if (instance && visibleInHierarchy(hit.object, instance.root)) return instance.actor.id;
    }
    return null;
  }

  function getActorScreenPosition(actorId: string): { x: number; y: number } | null {
    const instance = actors.get(actorId);
    if (!instance || !visible) return null;
    const rect = canvas.getBoundingClientRect();
    const point = instance.labelPoint.clone().applyMatrix4(instance.root.matrixWorld).project(camera);
    return {
      x: rect.left + (point.x + 1) * 0.5 * rect.width,
      y: rect.top + (1 - point.y) * 0.5 * rect.height,
    };
  }

  function setActors(nextActors: readonly ViviActor[]): void {
    if (!alive) return;
    let membershipChanged = false;
    const nextIds = new Set<string>();
    for (const input of nextActors) {
      const actor = copyActor(input);
      if (nextIds.has(actor.id)) continue;
      nextIds.add(actor.id);
      const existing = actors.get(actor.id);
      if (!existing) {
        membershipChanged = true;
        actors.set(actor.id, createInstance(actor));
      } else {
        existing.actor = actor;
        if (existing.palette !== actor.palette) applyPalette(existing, actor.palette);
        if (existing.mood !== actor.mood) setMood(existing, actor.mood);
      }
    }
    for (const [id, instance] of actors) {
      if (nextIds.has(id)) continue;
      membershipChanged = true;
      disposeInstance(instance);
      actors.delete(id);
    }
    if (membershipChanged) {
      interactiveMeshes.length = 0;
      for (const instance of actors.values()) interactiveMeshes.push(...instance.hitMeshes);
      layout();
    }
    if (visible) startLoop();
  }

  function setVisible(nextVisible: boolean): void {
    if (visible === nextVisible) return;
    visible = nextVisible;
    world.visible = visible;
    if (visible) {
      layout();
      startLoop();
      if (!document.hidden) renderer.render(scene, camera);
    } else {
      stopLoop();
      dragPhysics.reset();
      dragActive = false;
      const rest = dragPhysics.step(0);
      for (const instance of actors.values()) {
        instance.dragRig.restore();
        instance.dragRig.apply(rest, instance.activity.step(0));
      }
      renderer.clear();
    }
  }

  function setDragMotion(motion: ViviDragMotion): void {
    if (!alive || !visible || (pendingMotion && motion.at <= pendingMotion.at)) return;
    pendingMotion = motion;
    settledSince = undefined;
    dragPhysics.sample(motion);
    dragActive = true;
    activeUntil = performance.now() + 500;
    startLoop();
  }

  function setClickable(nextClickable: boolean): void {
    clickable = nextClickable;
  }

  function poke(actorId: string): void {
    const instance = actors.get(actorId);
    if (!instance || !clickable) return;
    instance.activity.triggerNext();
    activeUntil = performance.now() + 500;
    startLoop();
  }

  const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize);
  resizeObserver?.observe(canvas);
  const onWindowResize = (): void => resize();
  const onVisibilityChange = (): void => {
    if (document.hidden) stopLoop();
    else if (visible) {
      resize();
      startLoop();
    }
  };
  window.addEventListener("resize", onWindowResize);
  document.addEventListener("visibilitychange", onVisibilityChange);
  resize();

  return {
    setActors,
    setVisible,
    prepareFrame(): void {
      if (!alive) return;
      world.visible = true;
      const dragPose = dragPhysics.step(0);
      for (const instance of actors.values()) {
        instance.dragRig.restore();
        instance.mixer.update(0);
        instance.dragRig.apply(dragPose, instance.activity.step(0, dragPose.active));
      }
      renderer.render(scene, camera);
      world.visible = visible;
    },
    setClickable,
    setDragMotion,
    hitTest,
    getActorScreenPosition,
    poke,
    cleanup(): void {
      if (!alive) return;
      alive = false;
      stopLoop();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", onWindowResize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const instance of actors.values()) disposeInstance(instance);
      actors.clear();
      interactiveMeshes.length = 0;
      for (const geometry of sourceGeometries) geometry.dispose();
      for (const material of sourceMaterials) disposeMaterial(material);
      environment.dispose();
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
