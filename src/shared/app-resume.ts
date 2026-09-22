import { ALL_SCOPES, isValidEventCursor, type AppEventCursor } from "./app-protocol.ts";

/**
 * Resume after a dropped App Protocol socket.
 *
 * Cursors are canonical `{ epoch, seq }` per named scope. A bare number is not a
 * cursor: applying it to a new welcome epoch is how a restart gets skipped.
 *
 * `*` is live-only. The server will not replay it, and a cursor map only remembers
 * scopes that already produced an event — a conversation that first moved while we
 * were gone is invisible. Wildcard resume therefore cannot guarantee coverage, so
 * this helper never pretends a replay is complete: the web client (and any other
 * `*` subscriber) rebootstrap, i.e. reload snapshots, rather than apply a partial
 * journal.
 */

export type ScopeCursors = Record<string, AppEventCursor>;

export type ResumeRebootstrapReason = "epoch-changed" | "unseen-scopes" | "wildcard" | "no-cursors";

export type ResumePlan =
  | { kind: "replay"; epoch: string; since: ScopeCursors }
  | { kind: "rebootstrap"; reason: ResumeRebootstrapReason };

export function toScopeCursors(epoch: string, seqs: Record<string, number>): ScopeCursors {
  const out: ScopeCursors = {};
  if (typeof epoch !== "string" || epoch.length === 0) return out;
  for (const [scope, seq] of Object.entries(seqs)) {
    const cursor = { epoch, seq };
    if (!isValidEventCursor(cursor)) continue;
    if (scope === ALL_SCOPES) continue;
    out[scope] = cursor;
  }
  return out;
}

/**
 * Scopes that may have moved while disconnected but have no cursor.
 *
 * A wildcard subscriber cannot list them — the answer is "unknown", which is why
 * `planResume` refuses to replay `*`.
 */
export function unseenScopes(cursors: ScopeCursors, expected: readonly string[]): string[] {
  const have = new Set(Object.keys(cursors));
  return expected.filter((scope) => scope !== ALL_SCOPES && !have.has(scope));
}

/**
 * Decide how to continue after a new welcome.
 *
 * Named scopes at the welcome epoch can be replayed for *those* scopes only. A
 * `*` subscription, an epoch change, or a cursor map that does not cover the
 * scopes we care about is a rebootstrap. The conservative product choice for
 * the remote web client is always rebootstrap: it subscribes to `*`.
 */
export function planResume(input: {
  welcomeEpoch: string;
  cursors: ScopeCursors;
  wildcard: boolean;
  expectedScopes?: readonly string[];
}): ResumePlan {
  if (typeof input.welcomeEpoch !== "string" || input.welcomeEpoch.length === 0) {
    return { kind: "rebootstrap", reason: "no-cursors" };
  }
  if (input.wildcard) {
    return { kind: "rebootstrap", reason: "wildcard" };
  }

  const since: ScopeCursors = {};
  for (const [scope, cursor] of Object.entries(input.cursors)) {
    if (scope === ALL_SCOPES) {
      return { kind: "rebootstrap", reason: "wildcard" };
    }
    if (!isValidEventCursor(cursor) || cursor.epoch !== input.welcomeEpoch) {
      return { kind: "rebootstrap", reason: "epoch-changed" };
    }
    since[scope] = { epoch: cursor.epoch, seq: cursor.seq };
  }

  if (Object.keys(since).length === 0) {
    return { kind: "rebootstrap", reason: "no-cursors" };
  }

  if (input.expectedScopes && unseenScopes(since, input.expectedScopes).length > 0) {
    return { kind: "rebootstrap", reason: "unseen-scopes" };
  }

  return { kind: "replay", epoch: input.welcomeEpoch, since };
}
