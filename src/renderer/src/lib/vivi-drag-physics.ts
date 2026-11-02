import type { ViviDragMotion } from "../../../shared/vivi.ts";

type Spring = { value: number; velocity: number };
type FootPose = { pitch: number; yaw: number; roll: number; lift: number };

export type ViviDragPose = {
  yaw: number;
  roll: number;
  pitch: number;
  offsetX: number;
  offsetY: number;
  stretch: number;
  squashX: number;
  squashY: number;
  leftFoot: FootPose;
  rightFoot: FootPose;
  active: boolean;
};

const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));
const spring = (): Spring => ({ value: 0, velocity: 0 });

function advance(s: Spring, target: number, stiffness: number, damping: number, delta: number, limit: number): void {
  s.velocity += ((target - s.value) * stiffness - s.velocity * damping) * delta;
  s.value += s.velocity * delta;
  if (Math.abs(s.value) > limit) {
    s.value = clamp(s.value, limit);
    if (s.value * s.velocity > 0) s.velocity = 0;
  }
  if (Math.abs(s.value - target) < 0.00001 && Math.abs(s.velocity) < 0.0001) {
    s.value = target;
    s.velocity = 0;
  }
}

export class ViviDragPhysics {
  #lastSample: ViviDragMotion | undefined;
  #dragging = false;
  #flying = false;
  #impactAge = 10;
  #impactX = 0;
  #impactY = 0;
  #impactStrength = 0;
  #sampleAge = 0;
  #vx = 0;
  #vy = 0;
  #ax = 0;
  #ay = 0;
  #time = 0;
  #effort = 0;
  #hold = spring();
  #yaw = spring();
  #roll = spring();
  #pitch = spring();
  #x = spring();
  #y = spring();
  #stretch = spring();

  sample(sample: ViviDragMotion): void {
    if (![sample.x, sample.y, sample.at, sample.size].every(Number.isFinite) || sample.size <= 0) return;
    const previous = this.#lastSample;
    if (previous && sample.at <= previous.at) return;
    const starting = sample.dragging && !this.#dragging;
    if (starting) {
      this.#vx = this.#vy = this.#ax = this.#ay = 0;
    } else if (previous?.dragging || previous?.flying) {
      const delta = (sample.at - previous.at) / 1000;
      if (delta >= 0.004 && delta <= 0.15) {
        const blend = 1 - Math.exp(-18 * delta);
        const vx = this.#vx + (clamp((sample.x - previous.x) / sample.size / delta, 12) - this.#vx) * blend;
        const vy = this.#vy + (clamp((sample.y - previous.y) / sample.size / delta, 12) - this.#vy) * blend;
        const accelerationBlend = 1 - Math.exp(-12 * delta);
        this.#ax += (clamp((vx - this.#vx) / delta, 90) - this.#ax) * accelerationBlend;
        this.#ay += (clamp((vy - this.#vy) / delta, 90) - this.#ay) * accelerationBlend;
        this.#vx = vx;
        this.#vy = vy;
      } else if (delta > 0.15) {
        this.#vx = this.#vy = this.#ax = this.#ay = 0;
      }
    }
    if ((this.#dragging || this.#flying) && !sample.dragging && !sample.flying) {
      this.#roll.velocity -= clamp(this.#vx * 0.35, 2.2);
      this.#pitch.velocity += clamp(this.#vy * 0.2, 1.3);
      this.#x.velocity -= clamp(this.#vx * 0.035, 0.2);
      this.#y.velocity += clamp(this.#vy * 0.025, 0.15);
      this.#vx = this.#vy = this.#ax = this.#ay = 0;
    }
    const impact = sample.impact;
    if (impact && [impact.x, impact.y, impact.speed].every(Number.isFinite) && impact.speed > 0) {
      this.#impactAge = 0;
      this.#impactX = clamp(impact.x, 1);
      this.#impactY = clamp(impact.y, 1);
      this.#impactStrength = Math.min(1, impact.speed / sample.size / 9);
      this.#roll.velocity -= this.#impactX * this.#impactStrength * 4;
      this.#pitch.velocity -= this.#impactY * this.#impactStrength * 2;
      this.#effort = Math.max(this.#effort, this.#impactStrength * 0.75);
    }
    this.#lastSample = { ...sample };
    this.#dragging = sample.dragging;
    this.#flying = sample.flying === true;
    this.#sampleAge = 0;
  }

  step(seconds: number): ViviDragPose {
    let remaining = Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 0.1)) : 0;
    while (remaining > 0) {
      const delta = Math.min(remaining, 1 / 120);
      remaining -= delta;
      this.#sampleAge += delta;
      this.#impactAge += delta;
      if (this.#sampleAge > 0.2) this.#flying = false;
      const moving = this.#dragging || this.#flying;
      if (this.#sampleAge > 0.08) {
        const decay = Math.exp(-16 * delta);
        this.#vx *= decay;
        this.#vy *= decay;
        this.#ax *= decay;
        this.#ay *= decay;
      }
      const speed = Math.hypot(this.#vx, this.#vy);
      const acceleration = Math.hypot(this.#ax, this.#ay);
      const effort = moving ? Math.min(1, (this.#dragging ? 0.22 : 0.08) + speed * 0.14 + acceleration * 0.012) : 0;
      this.#effort += (effort - this.#effort) * (1 - Math.exp(-8 * delta));
      this.#time += delta * (7 + this.#effort * 13);
      advance(this.#hold, this.#dragging ? 1 : 0, 160, 22, delta, 1);
      advance(this.#yaw, moving ? clamp(Math.atan2(this.#vx, 2.4), 1.1) : 0, 85, 12, delta, 1.22);
      advance(this.#roll, moving ? clamp(-this.#vx * 0.11 - this.#ax * 0.009, 0.62) : 0, 105, 9, delta, 0.76);
      advance(this.#pitch, moving ? clamp(this.#vy * 0.065 + this.#ay * 0.005, 0.32) : 0, 100, 11, delta, 0.4);
      advance(this.#x, moving ? clamp(-this.#vx * 0.014 - this.#ax * 0.001, 0.11) : 0, 120, 11, delta, 0.14);
      advance(this.#y, moving ? clamp(this.#vy * 0.009 + this.#ay * 0.0006, 0.065) + 0.035 : 0, 130, 11, delta, 0.11);
      advance(this.#stretch, moving ? Math.min(0.12, 0.035 + acceleration * 0.0015 + speed * 0.004) : 0, 150, 14, delta, 0.15);
    }
    const kick = this.#effort;
    const left = Math.sin(this.#time);
    const right = Math.sin(this.#time * 1.19 + 2.2);
    const hit = this.#impactStrength * Math.exp(-this.#impactAge * 11);
    const shake = hit * Math.sin(this.#impactAge * 42);
    const compression = hit * Math.cos(this.#impactAge * 17) * 0.24;
    const horizontalHit = Math.abs(this.#impactX);
    const verticalHit = Math.abs(this.#impactY);
    const pose: ViviDragPose = {
      yaw: this.#yaw.value,
      roll: this.#roll.value + shake * 0.14 * this.#impactX,
      pitch: this.#pitch.value + shake * 0.1 * this.#impactY,
      offsetX: this.#x.value + hit * this.#impactX * 0.035,
      offsetY: this.#y.value - hit * this.#impactY * 0.035,
      stretch: this.#stretch.value,
      squashX: 1 - compression * horizontalHit + compression * verticalHit * 0.5,
      squashY: 1 - compression * verticalHit + compression * horizontalHit * 0.5,
      leftFoot: {
        pitch: kick * (left * 1.15 + Math.sin(this.#time * 2.3) * 0.26),
        yaw: kick * Math.sin(this.#time * 1.4) * 0.3,
        roll: this.#hold.value * 0.2 + kick * Math.cos(this.#time * 1.7) * 0.4,
        lift: kick * (0.025 + Math.max(0, left) * 0.055),
      },
      rightFoot: {
        pitch: kick * (right * 1.15 + Math.sin(this.#time * 2.1 + 1) * 0.26),
        yaw: kick * Math.sin(this.#time * 1.6 + 1.4) * 0.3,
        roll: -this.#hold.value * 0.2 + kick * Math.cos(this.#time * 1.9 + 0.7) * 0.4,
        lift: kick * (0.025 + Math.max(0, right) * 0.055),
      },
      active: this.#dragging || this.#flying || hit > 0.001 || this.#effort > 0.001 || [this.#hold, this.#yaw, this.#roll, this.#pitch, this.#x, this.#y, this.#stretch]
        .some((s) => Math.abs(s.value) > 0.0001 || Math.abs(s.velocity) > 0.001),
    };
    return pose;
  }

  reset(): void {
    this.#lastSample = undefined;
    this.#dragging = false;
    this.#flying = false;
    this.#impactAge = 10;
    this.#impactX = this.#impactY = this.#impactStrength = 0;
    this.#sampleAge = this.#vx = this.#vy = this.#ax = this.#ay = this.#time = this.#effort = 0;
    for (const s of [this.#hold, this.#yaw, this.#roll, this.#pitch, this.#x, this.#y, this.#stretch]) {
      s.value = s.velocity = 0;
    }
  }
}
