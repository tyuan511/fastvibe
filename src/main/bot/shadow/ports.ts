// SPDX-License-Identifier: MIT
// Port semantics adapted from deepseek-ai/dsh-superagent-prototype; see ../core/NOTICE.md.
import type { Assessor, Executor, Outbox } from "../core/ports.ts";
import type { ShadowStore } from "./store.ts";
import type { WorkerToken } from "./engine.ts";

export interface AssessmentPayload { triggerId: string; evalId: string }
export interface LaunchPayload { ticketId: string; assignmentId: string }
export interface DeliveryPayload extends LaunchPayload { inputIds: string[] }

export const workerBindingKey = (ticketId: string): string => `shadow:worker:${ticketId}`;
export const releaseControlKey = (evalId: string): string => "shadow:release:" + evalId;
export const stopControlKey = (ticketId: string, assignmentId: string): string =>
  "shadow:stop:" + JSON.stringify([ticketId, assignmentId]);

export interface ReleaseControl { evalId: string; at: number; status: "pending" | "done" }
export interface StopControl extends LaunchPayload { reason: string; at: number; status: "pending" | "done"; binding?: WorkerToken }
export type ControlPayload = { type: "release"; controlKey: string; control: ReleaseControl }
  | { type: "stop"; controlKey: string; control: StopControl };

function isLaunchPayload(value: unknown, expected: LaunchPayload): boolean {
  if (!value || typeof value !== "object") return false;
  return "ticketId" in value && value.ticketId === expected.ticketId
    && "assignmentId" in value && value.assignmentId === expected.assignmentId;
}

function isDeliveryPayload(value: unknown, expected: DeliveryPayload): boolean {
  if (!isLaunchPayload(value, expected) || !value || typeof value !== "object" || !("inputIds" in value)) return false;
  const ids: unknown = value.inputIds;
  return Array.isArray(ids) && ids.length === expected.inputIds.length
    && ids.every((id: unknown, index: number) => id === expected.inputIds[index]);
}

/** Synchronous durable intents only; the caller owns dispatch after the outer transaction commits. */
export function createShadowPorts(
  store: ShadowStore,
  now: () => number,
  wake?: () => void,
): { assessor: Assessor; executor: Executor; outbox: Outbox } {
  const changed = (): void => { if (wake) store.afterCommit(wake); };

  const assessor: Assessor = {
    request(candidate): void {
      store.atomic(() => {
        // Eval identities are single-use, including released and terminal evaluations.
        if (store.effects.get("assessment", candidate.evalId)
          || store.get(releaseControlKey(candidate.evalId)) !== undefined) return;
        const triggerId = candidate.thread.evaluating?.primary ?? candidate.triggers[0]?.id;
        if (triggerId === undefined) throw new Error("Shadow assessment requires a primary trigger");
        const payload: AssessmentPayload = { triggerId, evalId: candidate.evalId };
        store.effects.enqueue("assessment", candidate.evalId, payload, now());
        changed();
      });
    },
    release(evalId): void {
      store.atomic(() => {
        let updated = false;
        const key = releaseControlKey(evalId);
        if (store.get(key) === undefined) {
          const control: ReleaseControl = { evalId, at: now(), status: "pending" };
          store.set(key, control);
          store.effects.enqueue("control", key, { type: "release", controlKey: key, control } satisfies ControlPayload, now());
          updated = true;
        }
        if (store.effects.cancelPending("assessment", evalId)) updated = true;
        if (updated) changed();
      });
    },
  };

  const executor: Executor = {
    start(ticket, assignment): void {
      store.atomic(() => {
        const payload: LaunchPayload = { ticketId: ticket.id, assignmentId: assignment.id };
        const current = store.effects.get("launch", assignment.id);
        // A terminal launch may be retried for the same pending Assignment after human followup.
        if (current && (current.status === "pending" || current.status === "running" || current.status === "uncertain")
          && isLaunchPayload(current.payload, payload)) return;
        store.effects.enqueue("launch", assignment.id, payload, now());
        changed();
      });
    },
    deliver(ticket, assignment): void {
      store.atomic(() => {
        const payload: DeliveryPayload = {
          ticketId: ticket.id, assignmentId: assignment.id, inputIds: [...ticket.undelivered],
        };
        const current = store.effects.get("delivery", ticket.id);
        // A new domain delivery request may reuse a terminal effect's input snapshot.
        if (current && (current.status === "pending" || current.status === "running" || current.status === "uncertain")
          && isDeliveryPayload(current.payload, payload)) return;
        store.effects.enqueue("delivery", ticket.id, payload, now());
        changed();
      });
    },
    stop(ticket, assignment, reason): void {
      store.atomic(() => {
        let updated = false;
        const key = stopControlKey(ticket.id, assignment.id);
        if (store.get(key) === undefined) {
          const binding = store.get<WorkerToken>(workerBindingKey(ticket.id));
          const control: StopControl = {
            ticketId: ticket.id, assignmentId: assignment.id, reason, at: now(), status: "pending",
            ...(binding?.assignmentId === assignment.id ? { binding } : {}),
          };
          store.set(key, control);
          store.effects.enqueue("control", key, { type: "stop", controlKey: key, control } satisfies ControlPayload, now());
          updated = true;
        }
        if (store.effects.cancelPending("launch", assignment.id)) updated = true;
        const delivery = store.effects.get("delivery", ticket.id);
        if (delivery && isLaunchPayload(delivery.payload, { ticketId: ticket.id, assignmentId: assignment.id })
          && store.effects.cancelPending("delivery", ticket.id)) updated = true;
        if (updated) changed();
      });
    },
  };

  const outbox: Outbox = {
    send(message): void {
      store.atomic(() => {
        if (!store.receipts.add(message)) return;
        store.effects.enqueue("reply", message.id, {}, now());
        changed();
      });
    },
    status(id) { return store.receipts.get(id)?.status; },
    withdraw(id): void {
      store.atomic(() => {
        if (!store.receipts.withdrawPending(id)) return;
        store.effects.cancelPending("reply", id);
        changed();
      });
    },
  };

  return { assessor, executor, outbox };
}
