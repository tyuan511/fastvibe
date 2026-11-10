// SPDX-License-Identifier: MIT
/** Explicit Main-lifecycle assembly. Not constructed by the production PiProcessManager before M12. */
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ViviBotFacade } from "./vivi-bot-facade.ts";
import { ViviRuntime, type ViviRuntimeOptions } from "./vivi-runtime.ts";
import type { ShadowStore } from "./store.ts";

export interface ViviModelBinding {
  /** The already initialized Main runtime; this host never creates or disposes it. */
  modelRuntime: ModelRuntime;
  /** A model selected and authenticated by Main's registry. */
  model: NonNullable<AgentSession["model"]>;
}
export interface ViviMainHostOptions extends Omit<ViviRuntimeOptions, "store" | "modelRuntime" | "model" | "onEvent"> {
  store: ShadowStore;
  /** Called only by start(), after Main model initialization. No model is a normal first-run state. */
  model: () => ViviModelBinding | undefined;
  onChanged?: Parameters<ViviBotFacade["onChanged"]>[0];
  onEvent?: ViviRuntimeOptions["onEvent"];
}

/**
 * Main supplies its live model binding and owns the database. A new Driver/Executor owner is
 * created on each explicit start after a completed stop. The public API object remains stable.
 * No constructor timer, model request, ordinary BotStore write, or default production registration.
 */
export class ViviMainHost {
  readonly api: ViviBotFacade;
  private readonly options: ViviMainHostOptions;
  private runtime?: ViviRuntime;
  private stopping?: Promise<void>;

  constructor(options: ViviMainHostOptions) {
    this.options = options;
    this.api = new ViviBotFacade(options.store);
    if (options.onChanged) this.api.onChanged(options.onChanged);
  }

  /** Returns false when Main currently has no authenticated model. */
  start(): boolean {
    if (this.stopping) throw new Error("Vivi host is stopping or requires shutdown reconciliation");
    if (this.runtime) return true;
    const binding = this.options.model();
    if (!binding) return false;
    const runtime = new ViviRuntime({ ...this.options, ...binding,
      onEvent: event => {
        this.api.notifyDomainEvent();
        this.options.onEvent?.(event);
      },
    });
    this.runtime = runtime;
    this.api.attachRuntime(runtime);
    runtime.start();
    return true;
  }

  async idle(): Promise<void> {
    await this.stopping;
    await this.runtime?.idle();
  }

  /** Must settle before Main releases its model runtime or closes the externally owned store. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const runtime = this.runtime;
    if (!runtime) return Promise.resolve();
    this.stopping = runtime.stop().then(() => {
      this.runtime = undefined;
      this.stopping = undefined;
    });
    return this.stopping;
  }
}
