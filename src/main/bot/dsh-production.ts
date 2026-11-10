// SPDX-License-Identifier: MIT
/**
 * The single production bridge into the DSH domain.
 *
 * Every M0–M11 module deliberately stayed unreachable from the application so that the isolated
 * work could never change what ships. This file is the one deliberate exception: the place where
 * a production Main opens the persistent Shadow store, composes one runtime, and publishes it as
 * the Bot API. `test/vivi-dsh-isolation.test.ts` names it explicitly, so any *other* production
 * module reaching into the domain still fails the build.
 *
 * What it does NOT do: it does not construct itself from `PiProcessManager`, migrate old data, or
 * replace the existing `BotRuntime`. Those remain the M12 steps, and they need a real migration
 * and rollback rehearsal rather than a silent swap on first boot.
 */
import { join } from "node:path";
import type { FastVibePaths } from "../engine/paths.ts";
import { DshBotFacade } from "./shadow/dsh-bot-facade.ts";
import { openShadowStore, type ShadowStore } from "./shadow/store.ts";
import { ViviDshRuntime, type ViviDshRuntimeOptions } from "./shadow/vivi-dsh-runtime.ts";
import type { ViviDshModelBinding } from "./shadow/main-host.ts";

/** Where the DSH database lives inside userData. Never inside `fastvibe.db`. */
export function viviDshProductionFile(paths: FastVibePaths): string {
  return join(paths.runtimeRoot, "vivi-dsh", "shadow.db");
}

/** Where the composed workers keep their stable execution directories. */
export function viviDshProductionRoot(paths: FastVibePaths): string {
  return join(paths.runtimeRoot, "vivi-dsh", "workers");
}

export interface ViviDshProductionOptions {
  paths: FastVibePaths;
  /** Main's already initialized and authenticated model binding. No model is a normal first-run state. */
  model: () => ViviDshModelBinding | undefined;
  /** Automatic intake scope; the repository or workspace the accepted work belongs to. */
  intake: { scope: string; enabled?: boolean; title?: (candidate: unknown) => string };
  maxWorkers?: () => number;
  /** Extra Source adapters composed onto the SAME driver and executor, e.g. GitHub. */
  compose?: ViviDshRuntimeOptions["compose"];
  beforePass?: ViviDshRuntimeOptions["beforePass"];
  onChanged?: Parameters<DshBotFacade["onChanged"]>[0];
  now?: () => number;
}

export interface ViviDshProduction {
  readonly store: ShadowStore;
  readonly api: DshBotFacade;
  /** Runs the composed Passes once; the pipeline's own driver has no wall-clock timer here. */
  idle(): Promise<void>;
  start(): boolean;
  stop(): Promise<void>;
}

/**
 * Open the production DSH store and compose one runtime.
 *
 * Construction performs no model request and starts no Pass; `start()` does, and returns false
 * while Main has no authenticated model. The store is closed by `stop()`.
 */
export function openViviDshProduction(options: ViviDshProductionOptions): ViviDshProduction {
  const userData = options.paths.userData;
  const store = openShadowStore(viviDshProductionFile(options.paths), error => {
    // A reporting hook must never throw into a transaction; log and keep the state.
    console.error("[vivi-dsh] shadow store reported an error", error);
  }, { allowedRoot: userData, purpose: "vivi-dsh-production" });
  const api = new DshBotFacade(store);
  if (options.onChanged) api.onChanged(options.onChanged);
  let runtime: ViviDshRuntime | undefined;
  let stopping: Promise<void> | undefined;
  return {
    store,
    api,
    start(): boolean {
      if (stopping) throw new Error("Vivi DSH production is stopping");
      if (runtime) return true;
      const binding = options.model();
      if (!binding) return false;
      const created = new ViviDshRuntime({
        store,
        root: viviDshProductionRoot(options.paths),
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
