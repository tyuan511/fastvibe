import { create } from "zustand";
import type { BotChanged, WorkSnapshot } from "@shared/bot";

type State = { snapshot: WorkSnapshot | null; loading: boolean; error: string | null };
const store = create<State>(() => ({ snapshot: null, loading: true, error: null }));
let scheduled: ReturnType<typeof setTimeout> | undefined;
let reading = false;
let pending = false;

export function adoptBotSnapshot(snapshot: WorkSnapshot): void {
  const current = store.getState().snapshot;
  if (current && snapshot.revision < current.revision) return;
  store.setState({ snapshot, loading: false, error: snapshot.error ?? null });
}

async function read(): Promise<void> {
  if (reading) { pending = true; return; }
  reading = true;
  try { adoptBotSnapshot(await window.fastvibe.bot.getWorkSnapshot()); }
  catch (cause) { store.setState({ loading: false, error: cause instanceof Error ? cause.message : String(cause) }); }
  finally {
    reading = false;
    if (pending) { pending = false; schedule(); }
  }
}
function schedule(): void {
  if (scheduled) return;
  scheduled = setTimeout(() => { scheduled = undefined; void read(); }, 80);
}

export function refreshBotSnapshot(): void { schedule(); }

export function useBotSnapshot(): State & { adopt: (snapshot: WorkSnapshot) => void; refresh: () => void } {
  const snapshot = store((state) => state.snapshot);
  const loading = store((state) => state.loading);
  const error = store((state) => state.error);
  return { snapshot, loading, error, adopt: adoptBotSnapshot, refresh: refreshBotSnapshot };
}

let subscribed = false;
export function ensureBotSnapshotSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  void read();
  window.fastvibe.bot.onChanged((event: BotChanged) => {
    const current = store.getState().snapshot;
    if (current && event.revision <= current.revision) return;
    schedule();
  });
}
ensureBotSnapshotSubscription();
