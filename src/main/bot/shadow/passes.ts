// SPDX-License-Identifier: MIT
// Pass lifecycle adapted from dsh-superagent/repo; see ../core/NOTICE.md.
import type { EngineForSources } from "../core/engine.ts";
import type { Trigger } from "../core/model.ts";
import type { ShadowEffects } from "./effects.ts";

export interface PassHealth { state: "ready" | "error" | "stopped"; detail: string; at: string }
export interface ShadowPassHost {
  engine: Pick<EngineForSources, "receive"> & { evaluateDue(): void | Promise<void> };
  effects: Pick<ShadowEffects, "pulse" | "idle">;
  configured(): boolean;
  closing(): boolean;
  recover?(): void;
  beforePass?(): void | Promise<void>;
}

/** Serial periodic/on-demand passes. Idle describes dispatchability, never Ticket completion. */
export class ShadowPasses {
  private readonly host: ShadowPassHost;
  private readonly now: () => number;
  private readonly intervalMs: number | false;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private started = false;
  private pumping?: Promise<void>;
  private again?: Promise<void>;
  private state: PassHealth;
  constructor(host: ShadowPassHost, options: { now?: () => number; intervalMs?: number | false } = {}) {
    this.host = host;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 2000;
    if (this.intervalMs !== false && (!Number.isSafeInteger(this.intervalMs) || this.intervalMs <= 0)) throw new Error("Invalid pass interval");
    this.state = { state: "ready", detail: "No pass has run", at: this.at() };
  }
  private at(): string { return new Date(this.now()).toISOString(); }
  health(): PassHealth { return { ...this.state }; }
  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    if (this.intervalMs !== false) {
      this.timer = setInterval(() => this.request(), this.intervalMs);
      this.timer.unref();
    }
    this.request();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.allSettled([this.pumping, this.again]);
    this.state = { state: "stopped", detail: "Passes stopped", at: this.at() };
  }
  receive(trigger: Trigger): ReturnType<EngineForSources["receive"]> {
    if (this.stopped || this.host.closing()) throw new Error("Shadow driver is stopping");
    const result = this.host.engine.receive(trigger);
    if (result === "stored") this.request();
    return result;
  }
  request(): void { void this.pump().catch(() => {}); }
  pump(): Promise<void> {
    if (this.stopped || !this.host.configured() || this.host.closing()) return Promise.resolve();
    if (this.pumping) {
      if (!this.again) {
        const follow = () => { this.again = undefined; return this.pump(); };
        this.again = this.pumping.then(follow, follow);
      }
      return this.again;
    }
    const running = this.once().then(() => {
      if (!this.stopped && !this.host.closing()) this.state = { state: "ready", detail: "Pass completed", at: this.at() };
    }, error => {
      if (!this.stopped) this.state = { state: "error", detail: String(error), at: this.at() };
      throw error;
    }).finally(() => { if (this.pumping === running) this.pumping = undefined; });
    this.pumping = running;
    return running;
  }
  async idle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([this.pumping, this.again]);
      await this.host.effects.idle();
      if (!this.pumping && !this.again) return;
    }
  }
  private async once(): Promise<void> {
    await this.host.beforePass?.();
    if (this.stopped || !this.host.configured() || this.host.closing()) return;
    this.host.effects.pulse();
    this.host.recover?.();
    if (this.stopped || this.host.closing()) return;
    await this.host.engine.evaluateDue();
  }
}
