// SPDX-License-Identifier: MIT
// Production-local DSH composition root. It intentionally knows only the Shadow domain.
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { DomainEvent, SourceScope } from "../core/ports.ts";
import type { Trigger, Ticket } from "../core/model.ts";
import { settingsPolicy, type Settings } from "../core/policy.ts";
import type { AdmissionRow } from "../core/admission.ts";
import { ShadowDriver } from "./driver.ts";
import type { ShadowAdapters } from "./driver.ts";
import type { ShadowEffects } from "./effects.ts";
import { ManagedPiAssessor } from "./pi-assessor.ts";
import { PiExecutor } from "./pi-executor.ts";
import { LocalSourceReplay } from "./local-source.ts";
import { ShadowSourceRegistry } from "./source-registry.ts";
import type { ShadowStore } from "./store.ts";
import { assertShadowPath } from "./schema.ts";

export interface ViviDshRuntimeAdapters extends Pick<ShadowAdapters, "assessment" | "release" | "relay" | "notice" | "source" | "operations"> {}
export interface ViviDshRuntimeComposeContext {
  store: ShadowStore;
  registry: ShadowSourceRegistry;
  engine: () => ShadowDriver["engine"];
  effects: () => ShadowEffects;
}
export interface ViviDshRuntimeOptions {
  store: ShadowStore;
  root: string;
  /** Explicitly authorizes a persistent production execution root. */
  allowedRoot?: string;
  modelRuntime: ModelRuntime;
  model: NonNullable<AgentSession["model"]>;
  maxWorkers: () => number;
  policy?: Settings;
  now?: () => number;
  adapters?: ViviDshRuntimeAdapters;
  compose?: (context: ViviDshRuntimeComposeContext) => ViviDshRuntimeAdapters;
  /**
   * Automatic Source intake. When enabled, the runtime builds its own isolated model assessor
   * from this same model binding and installs it as the assessment adapter, so an admitted
   * Trigger becomes a Ticket without a host operator deciding by hand.
   *
   * An explicit `adapters.assessment` always wins: a deployment that wants a different judge
   * (or a manual one) must pass it instead.
   */
  intake?: { enabled: boolean; scope: string; title?: (candidate: unknown) => string };
  beforePass?: () => void | Promise<void>;
  onEvent?: (event: DomainEvent) => void;
}
export interface ViviDshSubmit {
  requestId: string;
  text: string;
  title?: string;
  scope?: string;
}

const requestKey = (requestId: string): string => `vivi:dsh:local-request:${requestId}`;
const clone = <T>(value: T): T => structuredClone(value);
const defaultSettings = (): Settings => ({
  paused: false,
  policy: { rules: [], sources: { local: {
    allowed: [{ id: "user" }],
    admission: { local: { listedUnaddressed: "ignore", unlistedAddressed: "ignore", unlistedUnaddressed: "ignore" } satisfies AdmissionRow },
  } } },
  eval: { mode: "off", timeoutSeconds: 60 },
});

/**
 * The local DSH runtime is deliberately synchronous at its domain boundary and asynchronous
 * only at its Pass/Effect and SDK lifecycle boundary. Construction registers isolated local
 * source state and resources, but does not start a pass or activate a provider request.
 */
export class ViviDshRuntime {
  private readonly registry: ShadowSourceRegistry;
  private readonly driver: ShadowDriver;
  private readonly executor: PiExecutor;
  private readonly replay: LocalSourceReplay;
  private readonly store: ShadowStore;
  private readonly settings: Settings;
  private readonly intakeScope?: string;
  private readonly clock: () => number;
  private assessor?: Promise<ManagedPiAssessor>;
  private started = false;
  private stopped = false;
  private stopping?: Promise<void>;

  constructor(options: ViviDshRuntimeOptions) {
    assertShadowPath(options.root, { allowedRoot: options.allowedRoot });
    const purpose = options.store.db.get<{ value: string }>("SELECT value FROM dsh_shadow_meta WHERE key='purpose'")?.value;
    if (options.allowedRoot && purpose !== "vivi-dsh-production") throw new Error("显式执行 root 只允许 production Shadow store");
    if (!options.allowedRoot && purpose === "vivi-dsh-production") throw new Error("production Shadow store 必须显式提供 allowedRoot");
    this.store = options.store;
    this.clock = options.now ?? Date.now;
    this.settings = clone(options.policy ?? defaultSettings());
    this.intakeScope = options.intake?.scope;
    this.registry = new ShadowSourceRegistry(options.store, this.clock);
    this.registry.register({
      kind: "local",
      validate: value => {
        const channel = (value as { channel?: unknown } | null)?.channel;
        return { channel: typeof channel === "string" && channel.trim() ? channel.trim() : "local" };
      },
      scope: () => ({ listened: true, observed: false }),
    });
    if (!this.registry.instance("local")?.revision) this.registry.configure("local", { enabled: true, config: { channel: "local" } });
    const scope: SourceScope = this.registry;
    let driver: ShadowDriver | undefined;
    this.executor = new PiExecutor({
      store: options.store, root: options.root, allowedRoot: options.allowedRoot, engine: () => {
        if (!driver) throw new Error("Vivi DSH engine is not assembled");
        return driver.engine;
      }, enabled: () => this.started && !!driver && !driver.paused() && !this.stopped,
      modelRuntime: options.modelRuntime, model: options.model, maxWorkers: options.maxWorkers,
      now: this.clock, initialAssignment: true,
    });
    const composed = options.compose?.({ store: options.store, registry: this.registry,
      engine: () => { if (!driver) throw new Error("Vivi DSH composition is not ready"); return driver.engine; },
      effects: () => { if (!driver) throw new Error("Vivi DSH composition is not ready"); return driver.effects; },
    }) ?? {};
    const adapters = { ...options.adapters, ...composed };
    if (options.intake?.enabled && adapters.assessment === undefined) {
      // Automatic intake: the judge is a model in its own isolated Session, built from the
      // same binding as the workers. An explicit assessment adapter always wins (a deployment
      // that wants a manual or different judge passes one).
      const intakeScope = options.intake.scope;
      const intakeTitle = options.intake.title;
      // ManagedPiAssessor.open() is async while this constructor is synchronous, so the
      // instrument is created on the first assessment and reused afterwards.
      const assessor = (): Promise<ManagedPiAssessor> => (this.assessor ??= ManagedPiAssessor.open({
        store: options.store, root: options.root, ...(options.allowedRoot ? { allowedRoot: options.allowedRoot } : {}),
        modelRuntime: options.modelRuntime, model: options.model,
        describe: candidate => ({
          title: intakeTitle?.(candidate) ?? candidate.triggers[0]?.text.split("\n")[0]?.slice(0, 120) ?? "Vivi work",
          scope: intakeScope,
        }),
        decide: (triggerId, outcome) => { this.driver.engine.main.decide(triggerId, outcome); },
        now: this.clock,
      }));
      adapters.assessment = async candidate => {
        // A failed or undecided assessment must not fabricate a Decision: the Eval stays open and
        // the host sees the failed record. Only a real model decision reaches the domain.
        await (await assessor()).assess(candidate);
      };
    }
    driver = new ShadowDriver(options.store, {
      policy: () => settingsPolicy(this.settings, scope), scope, now: this.clock, onEvent: options.onEvent,
      beforePass: async () => { await this.executor.sweep(); await options.beforePass?.(); }, limits: { launch: options.maxWorkers },
    }, {
      ...adapters,
      ...this.executor.adapters,
    });
    this.driver = driver;
    this.replay = new LocalSourceReplay({ registry: this.registry, engine: this.driver.engine, now: this.clock });
  }

  start(): void {
    if (this.stopped) throw new Error("Vivi DSH runtime cannot restart");
    if (this.started) return;
    this.started = true;
    this.driver.start();
  }

  async idle(): Promise<void> {
    this.driver.passes.request();
    await this.driver.idle();
    await this.executor.sweep();
    await this.executor.idle();
    await this.driver.idle();
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopping = (async () => {
      const assessor = this.assessor;
      const results = await Promise.allSettled([this.driver.stop({ abort: true }), this.executor.stop(),
        assessor ? assessor.then(item => item.dispose(), () => undefined) : Promise.resolve()]);
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Vivi DSH shutdown failed");
    })();
    return this.stopping;
  }

  submit(input: ViviDshSubmit): string {
    if (this.stopped) throw new Error("Vivi DSH runtime is stopped");
    if (!input.requestId.trim() || !input.text.trim()) throw new Error("local requestId 和 text 不能为空");
    // A deployment's intake scope is the authority for locally submitted work; the caller may
    // narrow it but must not silently widen it to a generic "local" that ignores configuration.
    const payload = { text: input.text, title: input.title ?? input.text.slice(0, 120), scope: input.scope ?? this.intakeScope ?? "local" };
    const key = requestKey(input.requestId);
    return this.store.atomic(() => {
    const prior = this.store.get<{ payload: typeof payload; ticketId: string }>(key);
    if (prior) {
      if (JSON.stringify(prior.payload) !== JSON.stringify(payload)) throw new Error("同一 requestId 的 payload 不可改变");
      return prior.ticketId;
    }
    const trigger: Trigger = { id: `local:${input.requestId}`, source: "local", threads: [{ source: "local", id: `request:${input.requestId}` }],
      actor: { source: "local", id: "user" }, human: true, addressed: "direct", at: new Date(this.clock()).toISOString(), text: input.text,
      meta: { requestId: input.requestId, title: payload.title, scope: payload.scope } };
    this.replay.receive(trigger);
    this.driver.engine.evaluateDue();
    const candidate = this.driver.engine.main.candidate(trigger.id);
    if (!candidate) throw new Error("local request was not admitted");
    const result = this.driver.engine.main.decide(trigger.id, { evalId: candidate.evalId, kind: "accept", title: payload.title, scope: payload.scope, reason: input.text });
    if (!result.ticketId) throw new Error("local request did not create a Ticket");
    this.store.set(key, { payload, ticketId: result.ticketId });
    return result.ticketId;
    });
  }

  ticket(ticketId: string): Ticket | undefined { return clone(this.store.tickets.get(ticketId)); }
  tickets(): Ticket[] { return this.store.tickets.list().map(clone); }
  /**
   * Answer a ticket's open question through the domain's own reply path.
   *
   * The question identity comes from the durable Ticket, never from the caller: `answer` only
   * carries what the person typed. `Replies.answer` re-checks that the text still matches the
   * open attention, so a stale panel cannot reply to a question that was already replaced.
   */
  answerAttention(attentionId: string, text: string): Ticket {
    if (this.stopped) throw new Error("Vivi DSH runtime is stopped");
    if (!text.trim()) throw new Error("attention 答复不能为空");
    return this.store.atomic(() => {
      const ticket = this.store.tickets.list().find(item => item.attention?.id === attentionId);
      if (!ticket?.attention) throw new Error("attention 不存在或已被替换");
      const trigger = ticket.attention.triggerId ? this.store.triggers.get(ticket.attention.triggerId) : undefined;
      this.driver.engine.main.reply({ purpose: "attention", ticketId: ticket.id, question: ticket.attention.question,
        ...(trigger ? { triggerId: trigger.id } : {}), text });
      return clone(this.store.tickets.get(ticket.id)!);
    });
  }
  stopTicket(ticketId: string, reason?: string): Ticket {
    if (this.stopped) throw new Error("Vivi DSH runtime is stopped");
    return clone(this.driver.engine.people.stopTicket(ticketId, reason));
  }
  retryTicket(ticketId: string): Ticket {
    if (this.stopped) throw new Error("Vivi DSH runtime is stopped");
    return clone(this.driver.engine.people.retryTicket(ticketId));
  }
}
