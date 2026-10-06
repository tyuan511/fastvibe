import { useCallback, useEffect, useRef } from "react";
import type { ChatAttachment, EngineModel } from "@shared/types";

const DRAFT_KEY = "fastvibe.session-drafts";

export type PersistedDraft = {
  draft: string;
  attachments: ChatAttachment[];
  model?: EngineModel;
  thinkingLevel?: string;
};

function isStoredModel(value: unknown): value is EngineModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<EngineModel>;
  return typeof model.provider === "string" && model.provider.length > 0 && typeof model.id === "string" && model.id.length > 0;
}

function isStoredAttachment(value: unknown): value is ChatAttachment {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Partial<ChatAttachment>;
  return (
    typeof attachment.id === "string" &&
    (attachment.kind === "image" || attachment.kind === "file") &&
    typeof attachment.name === "string"
  );
}

export function readDrafts(): Record<string, PersistedDraft> {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const drafts: Record<string, PersistedDraft> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const item = value as Partial<PersistedDraft>;
      if (typeof item.draft !== "string") continue;
      drafts[id] = {
        draft: item.draft,
        attachments: Array.isArray(item.attachments) ? item.attachments.filter(isStoredAttachment) : [],
        ...(isStoredModel(item.model) ? { model: item.model } : {}),
        ...(typeof item.thinkingLevel === "string" ? { thinkingLevel: item.thinkingLevel } : {}),
      };
    }
    return drafts;
  } catch {
    return {};
  }
}

function writeDraft(id: string | null, state: PersistedDraft): void {
  if (!id) return;
  try {
    const drafts = readDrafts();
    const hasPayload = Boolean(
      state.draft ||
      state.attachments.length > 0 ||
      state.model ||
      state.thinkingLevel,
    );
    if (hasPayload) drafts[id] = state;
    else delete drafts[id];
    localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
  } catch {
    // Ignore storage quota and private-mode errors.
  }
}

const DRAFT_DEBOUNCE_MS = 400;

/** Persist the composer's draft without synchronously writing on every keystroke. */
export function useDraftPersistence(
  activeId: string | null,
  draft: string,
  attachments: ChatAttachment[],
  model: EngineModel | undefined,
  thinkingLevel: string | undefined,
  emptySession: boolean,
): void {
  const pending = useRef<{ id: string | null; state: PersistedDraft } | null>(null);
  const timer = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const entry = pending.current;
    pending.current = null;
    if (entry) writeDraft(entry.id, entry.state);
  }, []);

  const lastId = useRef(activeId);
  useEffect(() => {
    if (lastId.current !== activeId) {
      flush();
      lastId.current = activeId;
    }
    pending.current = {
      id: activeId,
      state: {
        draft,
        attachments,
        ...(emptySession && model ? { model } : {}),
        ...(emptySession && thinkingLevel ? { thinkingLevel } : {}),
      },
    };
    if (timer.current === null) timer.current = window.setTimeout(flush, DRAFT_DEBOUNCE_MS);
  }, [activeId, attachments, draft, emptySession, flush, model, thinkingLevel]);

  useEffect(() => {
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [flush]);
}
