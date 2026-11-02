import type { ViviMood } from "../../../shared/vivi.ts";

export type ViviGesture =
  | "blink" | "double-blink" | "wink" | "mouth-open" | "yawn"
  | "look-around" | "look-back" | "stretch" | "tiptoe" | "hop" | "sway" | "spin"
  | "ponder" | "inspect-sparkle" | "thinking-turn"
  | "march" | "shuffle" | "work-turn"
  | "beckon" | "toe-tap" | "waiting-look"
  | "celebrate" | "happy-dance" | "victory-spin"
  | "wobble" | "head-shake" | "recover";

type FootPose = { pitch: number; yaw: number; roll: number; lift: number };

export type ViviActivityPose = {
  yaw: number;
  pitch: number;
  roll: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  stretch: number;
  headYaw: number;
  headPitch: number;
  headRoll: number;
  leftBlink: number;
  rightBlink: number;
  mouthOpen: number;
  leftFoot: FootPose;
  rightFoot: FootPose;
  gesture: ViviGesture | null;
  active: boolean;
  reaction: number;
};

export const VIVI_GESTURES: Record<ViviMood, readonly ViviGesture[]> = {
  idle: ["blink", "double-blink", "wink", "mouth-open", "yawn", "look-around", "look-back", "stretch", "tiptoe", "hop", "sway", "spin"],
  thinking: ["ponder", "inspect-sparkle", "thinking-turn"],
  working: ["march", "shuffle", "work-turn"],
  waiting: ["beckon", "toe-tap", "waiting-look"],
  success: ["victory-spin", "celebrate", "happy-dance"],
  error: ["wobble", "head-shake", "recover"],
};

const CLICK_REACTIONS = VIVI_GESTURES.idle;

const DURATIONS: Record<ViviGesture, number> = {
  blink: 0.65, "double-blink": 1.05, wink: 1.25, "mouth-open": 1.5, yawn: 2.8,
  "look-around": 3.2, "look-back": 3.4, stretch: 3.5, tiptoe: 2.8, hop: 2.2, sway: 3.4, spin: 3.1,
  ponder: 3.4, "inspect-sparkle": 3.2, "thinking-turn": 4.2,
  march: 3.4, shuffle: 3.1, "work-turn": 3.8,
  beckon: 2.8, "toe-tap": 3.2, "waiting-look": 3.8,
  "victory-spin": 2.8, celebrate: 2.5, "happy-dance": 3.8,
  wobble: 2.4, "head-shake": 2.8, recover: 3.6,
};

const FIRST_GESTURE: Partial<Record<ViviMood, ViviGesture>> = {
  thinking: "ponder", working: "march", waiting: "beckon", success: "victory-spin", error: "wobble",
};
const TAU = Math.PI * 2;
const smooth = (u: number): number => u * u * u * (u * (u * 6 - 15) + 10);
const angleDifference = (a: number, b: number): number => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const BODY_KEYS = ["yaw", "pitch", "roll", "offsetX", "offsetY", "offsetZ", "stretch", "headYaw", "headPitch", "headRoll"] as const;
const FOOT_KEYS = ["pitch", "yaw", "roll", "lift"] as const;

function restPose(): ViviActivityPose {
  return {
    yaw: 0, pitch: 0, roll: 0, offsetX: 0, offsetY: 0, offsetZ: 0, stretch: 0,
    headYaw: 0, headPitch: 0, headRoll: 0,
    leftBlink: 0, rightBlink: 0, mouthOpen: 0,
    leftFoot: { pitch: 0, yaw: 0, roll: 0, lift: 0 },
    rightFoot: { pitch: 0, yaw: 0, roll: 0, lift: 0 },
    gesture: null, active: false, reaction: 0,
  };
}

function stepping(pose: ViviActivityPose, phase: number, strength: number): void {
  const left = Math.sin(phase);
  const right = Math.sin(phase + Math.PI);
  pose.leftFoot.pitch += left * strength * 0.7;
  pose.rightFoot.pitch += right * strength * 0.7;
  pose.leftFoot.lift += Math.max(0, left) * strength * 0.035;
  pose.rightFoot.lift += Math.max(0, right) * strength * 0.035;
}

const pulse = (u: number, start: number, end: number): number => u <= start || u >= end ? 0 : Math.sin(Math.PI * (u - start) / (end - start)) ** 2;

function perform(pose: ViviActivityPose, gesture: ViviGesture, u: number, direction: number): void {
  const envelope = Math.sin(Math.PI * u) ** 2;
  const wave = Math.sin(TAU * u);
  const double = Math.sin(TAU * u * 2);
  const turn = direction * envelope;
  pose.gesture = gesture;
  switch (gesture) {
    case "blink":
      pose.leftBlink = pose.rightBlink = pulse(u, 0.08, 0.64);
      pose.headPitch += envelope * 0.08;
      break;
    case "double-blink":
      pose.leftBlink = pose.rightBlink = Math.max(pulse(u, 0.04, 0.34), pulse(u, 0.42, 0.75));
      pose.headRoll += turn * 0.1;
      break;
    case "wink":
      pose.leftBlink = direction < 0 ? pulse(u, 0.08, 0.8) : 0;
      pose.rightBlink = direction > 0 ? pulse(u, 0.08, 0.8) : 0;
      pose.headRoll += turn * 0.2;
      pose.mouthOpen = envelope * 0.2;
      break;
    case "mouth-open":
      pose.mouthOpen = pulse(u, 0.04, 0.85);
      pose.headPitch -= envelope * 0.12;
      pose.headRoll += turn * 0.1;
      break;
    case "yawn":
      pose.mouthOpen = envelope;
      pose.leftBlink = pose.rightBlink = envelope * 0.82;
      pose.headPitch -= envelope * 0.22;
      pose.stretch += envelope * 0.07;
      break;
    case "look-around":
      pose.yaw += wave * 0.85;
      pose.headYaw += Math.sin(TAU * u + 0.5) * envelope * 0.25;
      pose.headRoll += wave * 0.09;
      break;
    case "look-back":
      pose.yaw += turn * 2.25;
      pose.headYaw -= turn * 0.25;
      pose.roll += turn * 0.08;
      stepping(pose, TAU * u * 2, envelope * 0.45);
      break;
    case "stretch":
      pose.stretch += envelope * 0.12;
      pose.offsetY += envelope * 0.025;
      pose.pitch -= envelope * 0.16;
      pose.headPitch -= envelope * 0.13;
      pose.headRoll += wave * envelope * 0.14;
      pose.leftFoot.roll += envelope * 0.18;
      pose.rightFoot.roll -= envelope * 0.18;
      break;
    case "tiptoe":
      pose.offsetY += envelope * 0.05;
      pose.pitch += envelope * 0.1;
      pose.headYaw += turn * 0.35;
      pose.yaw += turn * 0.55;
      pose.leftFoot.pitch -= envelope * 0.4;
      pose.rightFoot.pitch -= envelope * 0.4;
      break;
    case "hop": {
      const bounce = Math.abs(Math.sin(Math.PI * u * 3));
      pose.offsetY += bounce * envelope * 0.075;
      pose.stretch += envelope * (bounce * 0.1 - (1 - bounce) * 0.055);
      pose.yaw += turn * 0.55;
      pose.leftFoot.pitch += envelope * bounce * 0.5;
      pose.rightFoot.pitch += envelope * bounce * 0.5;
      break;
    }
    case "sway":
      pose.roll += double * envelope * 0.17;
      pose.yaw += wave * 0.65;
      pose.offsetX += double * envelope * 0.025;
      pose.headRoll -= double * envelope * 0.11;
      stepping(pose, TAU * u * 2, envelope * 0.45);
      break;
    case "spin":
    case "victory-spin": {
      const celebrating = gesture === "victory-spin";
      pose.yaw += direction * TAU * smooth(u);
      pose.offsetY += envelope * (celebrating ? 0.09 : 0.04);
      pose.roll += wave * envelope * (celebrating ? 0.18 : 0.1);
      pose.stretch += envelope * 0.045;
      stepping(pose, TAU * u * 4, envelope * (celebrating ? 1 : 0.65));
      break;
    }
    case "ponder":
      pose.yaw += turn * 0.75;
      pose.headRoll += turn * 0.2;
      pose.headPitch += envelope * 0.12;
      pose.pitch += envelope * 0.07;
      pose.rightFoot.pitch += Math.sin(TAU * u * 2.5) * envelope * 0.25;
      break;
    case "inspect-sparkle":
      pose.yaw -= turn * 0.95;
      pose.headYaw += turn * 0.35;
      pose.headPitch -= envelope * 0.26;
      pose.pitch -= envelope * 0.12;
      pose.offsetY += envelope * 0.025;
      break;
    case "thinking-turn":
      pose.yaw += turn * 1.65;
      pose.headYaw -= turn * 0.25;
      pose.offsetX += wave * envelope * 0.035;
      pose.offsetZ += envelope * 0.025;
      stepping(pose, TAU * u * 3, envelope * 0.4);
      break;
    case "march":
      pose.yaw += wave * 0.55;
      pose.offsetY += Math.abs(Math.sin(TAU * u * 3)) * envelope * 0.035;
      pose.roll += Math.sin(TAU * u * 3) * envelope * 0.1;
      pose.pitch += envelope * 0.09;
      stepping(pose, TAU * u * 3, envelope * 0.9);
      break;
    case "shuffle":
      pose.offsetX += wave * envelope * 0.045;
      pose.yaw += wave * 0.9;
      pose.roll -= wave * envelope * 0.12;
      stepping(pose, TAU * u * 4, envelope * 0.8);
      break;
    case "work-turn":
      pose.yaw += turn * 2;
      pose.headYaw += wave * envelope * 0.2;
      pose.offsetY += Math.abs(Math.sin(TAU * u * 3)) * envelope * 0.025;
      stepping(pose, TAU * u * 4, envelope * 0.8);
      break;
    case "beckon":
      pose.pitch += Math.sin(TAU * u * 2) * envelope * 0.17;
      pose.headPitch += Math.sin(TAU * u * 2 + 0.4) * envelope * 0.15;
      pose.yaw += turn * 0.5;
      pose.offsetZ += envelope * 0.035;
      break;
    case "toe-tap":
      pose.yaw += turn * 0.55;
      pose.roll -= envelope * 0.08;
      pose.headRoll += envelope * 0.13;
      pose.rightFoot.pitch += Math.sin(TAU * u * 4) * envelope * 0.6;
      pose.rightFoot.lift += Math.max(0, Math.sin(TAU * u * 4)) * envelope * 0.025;
      break;
    case "waiting-look":
      pose.yaw += wave * 1.2;
      pose.headYaw += wave * envelope * 0.2;
      pose.headRoll += double * envelope * 0.12;
      stepping(pose, TAU * u * 2, envelope * 0.35);
      break;
    case "celebrate":
      pose.offsetY += Math.abs(Math.sin(Math.PI * u * 3)) * envelope * 0.1;
      pose.yaw += wave * 0.9;
      pose.stretch += Math.sin(TAU * u * 3) * envelope * 0.07;
      pose.leftFoot.roll += envelope * 0.35;
      pose.rightFoot.roll -= envelope * 0.35;
      break;
    case "happy-dance":
      pose.yaw += wave * 1.25;
      pose.roll += double * envelope * 0.2;
      pose.headRoll -= double * envelope * 0.14;
      pose.offsetY += Math.abs(double) * envelope * 0.045;
      stepping(pose, TAU * u * 4, envelope);
      break;
    case "wobble":
      pose.roll += Math.sin(TAU * u * 3) * envelope * 0.24;
      pose.yaw += wave * 0.6;
      pose.stretch -= envelope * 0.055;
      pose.offsetX += Math.sin(TAU * u * 3) * envelope * 0.02;
      stepping(pose, TAU * u * 3, envelope * 0.6);
      break;
    case "head-shake":
      pose.headYaw += Math.sin(TAU * u * 3) * envelope * 0.35;
      pose.yaw += Math.sin(TAU * u * 3 + 0.4) * envelope * 0.25;
      pose.pitch += envelope * 0.12;
      pose.headRoll += turn * 0.12;
      break;
    case "recover":
      pose.pitch += envelope * 0.2;
      pose.headPitch += envelope * 0.16;
      pose.yaw += turn * 0.8;
      pose.stretch -= envelope * 0.045;
      pose.offsetY -= envelope * 0.018;
      pose.leftFoot.roll += envelope * 0.12;
      pose.rightFoot.roll -= envelope * 0.12;
      break;
  }
}

export class ViviActivityMotion {
  #mood: ViviMood;
  #random: () => number;
  #time = 0;
  #elapsed = 0;
  #wait = 0.5;
  #gesture: ViviGesture | null = null;
  #previous: ViviGesture | null = null;
  #bag: ViviGesture[] = [];
  #direction = 1;
  #suppressed = false;
  #pose = restPose();
  #clickIndex = 0;
  #clicked = false;
  #reactionAge = 10;

  constructor(mood: ViviMood = "idle", random: () => number = Math.random) {
    this.#mood = mood;
    this.#random = random;
    if (mood !== "idle") this.#begin(FIRST_GESTURE[mood]!);
  }

  setMood(mood: ViviMood): void {
    if (mood === this.#mood) return;
    this.#mood = mood;
    this.#clicked = false;
    this.#reactionAge = 10;
    this.#gesture = null;
    this.#bag = [];
    this.#previous = null;
    this.#elapsed = 0;
    this.#wait = 0.25;
    if (mood !== "idle" && !this.#suppressed) this.#begin(FIRST_GESTURE[mood]!);
  }

  triggerNext(): void {
    if (this.#suppressed) return;
    if (this.#mood === "idle") {
      let gesture = CLICK_REACTIONS[this.#clickIndex++ % CLICK_REACTIONS.length];
      if (gesture === this.#previous) gesture = CLICK_REACTIONS[this.#clickIndex++ % CLICK_REACTIONS.length];
      this.#begin(gesture);
    } else this.#begin(this.#next());
    this.#clicked = true;
    this.#reactionAge = 0;
  }

  get active(): boolean { return this.#pose.active; }

  #unit(): number {
    const value = this.#random();
    return Number.isFinite(value) ? Math.max(0, Math.min(0.999999, value)) : 0.5;
  }

  #begin(gesture: ViviGesture): void {
    this.#gesture = gesture;
    this.#previous = gesture;
    this.#elapsed = 0;
    this.#clicked = false;
    this.#direction = this.#unit() < 0.5 ? -1 : 1;
  }

  #next(): ViviGesture {
    if (!this.#bag.length) {
      this.#bag = [...VIVI_GESTURES[this.#mood]];
      for (let index = this.#bag.length - 1; index > 0; index--) {
        const other = Math.floor(this.#unit() * (index + 1));
        [this.#bag[index], this.#bag[other]] = [this.#bag[other], this.#bag[index]];
      }
    }
    if (this.#bag.length > 1 && this.#bag.at(-1) === this.#previous) {
      [this.#bag[0], this.#bag[this.#bag.length - 1]] = [this.#bag[this.#bag.length - 1], this.#bag[0]];
    }
    return this.#bag.pop()!;
  }

  #duration(): number {
    if (!this.#gesture) return 1;
    const natural = DURATIONS[this.#gesture];
    return this.#clicked ? Math.min(natural, this.#gesture === "spin" ? 0.85 : 1.25) : natural;
  }

  step(seconds: number, suppressed = false): ViviActivityPose {
    const delta = Number.isFinite(seconds) ? Math.max(0, Math.min(0.1, seconds)) : 0;
    if (suppressed && !this.#suppressed) {
      this.#gesture = null;
      this.#reactionAge = 10;
      this.#wait = 0.7;
    }
    this.#suppressed = suppressed;
    if (!suppressed) {
      this.#time += delta;
      this.#reactionAge += delta;
      if (this.#gesture) {
        this.#elapsed += delta;
        if (this.#elapsed >= this.#duration()) {
          this.#gesture = null;
          this.#wait = this.#mood === "idle" ? 0.8 + this.#unit() * 1.8 : 0.4 + this.#unit() * 1.2;
        }
      } else {
        this.#wait -= delta;
        if (this.#wait <= 0) this.#begin(this.#next());
      }
    }

    const target = restPose();
    if (!suppressed) {
      const t = this.#time;
      target.yaw = Math.sin(t * 0.75) * 0.065;
      target.roll = Math.sin(t * 1.15) * 0.018;
      target.stretch = Math.sin(t * 2) * 0.008;
      target.headYaw = Math.sin(t * 0.9) * 0.035;
      target.headRoll = Math.sin(t * 1.1) * 0.025;
      if (this.#gesture) perform(target, this.#gesture, this.#elapsed / this.#duration(), this.#direction);
      const reaction = Math.exp(-this.#reactionAge * 10) * Math.sin(this.#reactionAge * 24);
      target.offsetY += Math.abs(reaction) * 0.055;
      target.stretch += reaction * 0.09;
      target.headRoll += reaction * 0.1;
      target.reaction = Math.exp(-this.#reactionAge * 10);
    }
    const blend = 1 - Math.exp(-(suppressed ? 18 : this.#clicked ? 36 : 13) * delta);
    for (const key of BODY_KEYS) {
      const difference = key === "yaw" ? angleDifference(target[key], this.#pose[key]) : target[key] - this.#pose[key];
      this.#pose[key] += difference * blend;
    }
    if (delta > 0) this.#pose.yaw = angleDifference(this.#pose.yaw, 0);
    for (const side of ["leftFoot", "rightFoot"] as const) {
      for (const key of FOOT_KEYS) this.#pose[side][key] += (target[side][key] - this.#pose[side][key]) * blend;
    }
    for (const key of ["leftBlink", "rightBlink", "mouthOpen"] as const) {
      const faceBlend = 1 - Math.exp(-(suppressed ? 22 : 65) * delta);
      this.#pose[key] += (target[key] - this.#pose[key]) * faceBlend;
    }
    this.#pose.reaction = target.reaction;
    this.#pose.gesture = suppressed ? null : this.#gesture;
    this.#pose.active = !suppressed && this.#gesture !== null;
    return { ...this.#pose, leftFoot: { ...this.#pose.leftFoot }, rightFoot: { ...this.#pose.rightFoot } };
  }
}
