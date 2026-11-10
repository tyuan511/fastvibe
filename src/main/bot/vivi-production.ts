// SPDX-License-Identifier: MIT
/**
 * The single production bridge into the Vivi domain.
 *
 * Every M0–M11 module deliberately stayed unreachable from the application so that the isolated
 * work could never change what ships. This file is the one deliberate exception: the place where
 * a production Main opens the persistent Shadow store, composes one runtime, and publishes it as
 * the Bot API. `test/vivi-isolation.test.ts` names it explicitly, so any *other* production
 * module reaching into the domain still fails the build.
 *
 * What it does NOT do: it does not construct itself from `PiProcessManager`, migrate old data, or
 * replace the existing `BotRuntime`. Those remain the M12 steps, and they need a real migration
 * and rollback rehearsal rather than a silent swap on first boot.
 */
import { join } from "node:path";
import type { FastVibePaths } from "../engine/paths.ts";
import { ViviBotFacade } from "./shadow/vivi-bot-facade.ts";
import { openShadowStore, type ShadowStore } from "./shadow/store.ts";
import { ViviRuntime, type ViviRuntimeOptions } from "./shadow/vivi-runtime.ts";
import type { ViviModelBinding } from "./shadow/main-host.ts";

/** Where the Vivi database lives inside userData. Never inside `fastvibe.db`. */
export function viviProductionFile(paths: FastVibePaths): string {
  return join(paths.runtimeRoot, "vivi", "shadow.db");
}

/** Where the composed workers keep their stable execution directories. */
export function viviProductionRoot(paths: FastVibePaths): string {
  return join(paths.runtimeRoot, "vivi", "workers");
}

export interface ViviProductionOptions {
  paths: FastVibePaths;
  /** Main's already initialized and authenticated model binding. No model is a normal first-run state. */
  model: () => ViviModelBinding | undefined;
  /** Automatic intake scope; the repository or workspace the accepted work belongs to. */
  intake: { scope: string; enabled?: boolean; title?: (candidate: unknown) => string };
  maxWorkers?: () => number;
  /** Extra Source adapters composed onto the SAME driver and executor, e.g. GitHub. */
  compose?: ViviRuntimeOptions["compose"];
  beforePass?: ViviRuntimeOptions["beforePass"];
  onChanged?: Parameters<ViviBotFacade["onChanged"]>[0];
  now?: () => number;
}

export interface ViviProduction {
  readonly store: ShadowStore;
  readonly api: ViviBotFacade;
  /** Runs the composed Passes once; the pipeline's own driver has no wall-clock timer here. */
  idle(): Promise<void>;
  start(): boolean;
  stop(): Promise<void>;
}

/**
 * Open the production Vivi store and compose one runtime.
 *
 * Construction performs no model request and starts no Pass; `start()` does, and returns false
 * while Main has no authenticated model. The store is closed by `stop()`.
 */
export function openViviProduction(options: ViviProductionOptions): ViviProduction {
  const userData = options.paths.userData;
  const store = openShadowStore(viviProductionFile(options.paths), error => {
    // A reporting hook must never throw into a transaction; log and keep the state.
    console.error("[vivi] shadow store reported an error", error);
  }, { allowedRoot: userData, purpose: "vivi-production" });
  const api = new ViviBotFacade(store);
  if (options.onChanged) api.onChanged(options.onChanged);
  let runtime: ViviRuntime | undefined;
  let stopping: Promise<void> | undefined;
  return {
    store,
    api,
    start(): boolean {
      if (stopping) throw new Error("Vivi Vivi production is stopping");
      if (runtime) return true;
      const binding = options.model();
      if (!binding) return false;
      const created = new ViviRuntime({
        store,
        root: viviProductionRoot(options.paths),
        allowedRoot: userData,
        ...binding,
        maxWorkers: options.maxWorkers ?? (() => 2),
        intake: { enabled: options.intake.enabled ?? true, scope: options.intake.scope, ...(options.intake.title ? { title: options.intake.title } : {}) },
        ...(options.compose ? { compose: options.compose } : {}),
        ...(options.beforePass ? { beforePass: options.beforePass } : {}),
        ...(options.now ? { now: options.now } : {}),
        onEvent: () => api.notifyDomainEvent(),
      });
      runtime = created;
      api.attachRuntime(created);
      created.start();
      return true;
    },
    async idle(): Promise<void> {
      await stopping;
      await runtime?.idle();
    },
    stop(): Promise<void> {
      if (stopping) return stopping;
      const current = runtime;
      if (!current) { store.close(); return Promise.resolve(); }
      stopping = current.stop().then(() => { runtime = undefined; stopping = undefined; store.close(); });
      return stopping;
    },
  };
}
