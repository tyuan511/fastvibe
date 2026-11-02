import type { ViviImpact } from "../../shared/vivi.ts";
import { clampViviBounds, type ViviBounds } from "./bounds.ts";

type Point = { x: number; y: number };
const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

export class ViviThrowVelocity {
  #last: (Point & { at: number }) | undefined;
  #movedAt = 0;
  #vx = 0;
  #vy = 0;
  #ax = 0;
  #ay = 0;

  begin(point: Point, at: number): void {
    this.#last = { ...point, at };
    this.#movedAt = at;
    this.#vx = this.#vy = this.#ax = this.#ay = 0;
  }

  sample(point: Point, at: number): void {
    const previous = this.#last;
    if (!previous || at <= previous.at || ![point.x, point.y, at].every(Number.isFinite)) return;
    const delta = (at - previous.at) / 1000;
    if (delta < 0.004) return;
    if (delta > 0.15) {
      this.begin(point, at);
      return;
    }
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    const blend = 1 - Math.exp(-28 * delta);
    const vx = this.#vx + (clamp(dx / delta, 6000) - this.#vx) * blend;
    const vy = this.#vy + (clamp(dy / delta, 6000) - this.#vy) * blend;
    const accelerationBlend = 1 - Math.exp(-14 * delta);
    this.#ax += (clamp((vx - this.#vx) / delta, 50000) - this.#ax) * accelerationBlend;
    this.#ay += (clamp((vy - this.#vy) / delta, 50000) - this.#ay) * accelerationBlend;
    this.#vx = vx;
    this.#vy = vy;
    if (Math.hypot(dx, dy) > 0.5) this.#movedAt = at;
    this.#last = { ...point, at };
  }

  release(at: number): Point {
    if (!this.#last || !Number.isFinite(at) || at < this.#last.at) return { x: 0, y: 0 };
    const age = Math.max(at - this.#movedAt, at - this.#last.at);
    const freshness = Math.exp(-Math.max(0, age - 35) / 45);
    const speed = Math.hypot(this.#vx, this.#vy);
    if (speed < 80 || freshness < 0.08) return { x: 0, y: 0 };
    // Acceleration along the release direction adds force; braking must not reverse a throw.
    const acceleration = Math.max(0, (this.#ax * this.#vx + this.#ay * this.#vy) / speed);
    const launchSpeed = Math.min(3600, speed + Math.min(speed * 0.65, acceleration * 0.035)) * freshness;
    return { x: this.#vx / speed * launchSpeed, y: this.#vy / speed * launchSpeed };
  }
}

export class ViviFlight {
  #bounds: ViviBounds;
  #area: ViviBounds;
  #vx: number;
  #vy: number;
  #elapsed = 0;
  #active: boolean;

  constructor(bounds: ViviBounds, velocity: Point, workArea: ViviBounds) {
    this.#bounds = clampViviBounds(bounds, workArea);
    this.#area = { ...workArea };
    this.#vx = Number.isFinite(velocity.x) ? velocity.x : 0;
    this.#vy = Number.isFinite(velocity.y) ? velocity.y : 0;
    this.#active = Math.hypot(this.#vx, this.#vy) >= 80;
  }

  get active(): boolean { return this.#active; }

  step(seconds: number): { bounds: ViviBounds; active: boolean; impact?: ViviImpact } {
    let remaining = Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 0.1)) : 0;
    let impact: ViviImpact | undefined;
    while (this.#active && remaining > 0) {
      const delta = Math.min(remaining, 1 / 120);
      remaining -= delta;
      this.#elapsed += delta;
      const decay = Math.exp(-3.6 * delta);
      const travel = (1 - decay) / 3.6;
      this.#bounds.x += this.#vx * travel;
      this.#bounds.y += this.#vy * travel;
      this.#vx *= decay;
      this.#vy *= decay;
      const minX = this.#area.x;
      const minY = this.#area.y;
      const maxX = minX + this.#area.width - this.#bounds.width;
      const maxY = minY + this.#area.height - this.#bounds.height;
      let nx = 0;
      let ny = 0;
      let speed = 0;
      if ((this.#bounds.x <= minX && this.#vx < 0) || (this.#bounds.x >= maxX && this.#vx > 0)) {
        nx = this.#vx < 0 ? 1 : -1;
        speed = Math.abs(this.#vx);
        this.#vx *= -0.42;
        this.#vy *= 0.85;
      }
      if ((this.#bounds.y <= minY && this.#vy < 0) || (this.#bounds.y >= maxY && this.#vy > 0)) {
        ny = this.#vy < 0 ? 1 : -1;
        speed = Math.hypot(speed, this.#vy);
        this.#vy *= -0.42;
        this.#vx *= 0.85;
      }
      this.#bounds = clampViviBounds(this.#bounds, this.#area);
      if (nx || ny) {
        const normal = Math.hypot(nx, ny);
        const next = { x: nx / normal, y: ny / normal, speed };
        if (!impact || next.speed > impact.speed) impact = next;
      }
      if (Math.hypot(this.#vx, this.#vy) < 18 || this.#elapsed >= 3) this.#active = false;
    }
    return { bounds: { ...this.#bounds }, active: this.#active, ...(impact ? { impact } : {}) };
  }
}
