import { useEffect, useMemo, useState } from "react";
import type { AgentThread } from "@shared/agent-thread";
import type { ChatMessage } from "@shared/types";
import { getAgentThreads, onEvent } from "./engine-client";
import { mergeReviewThreads, projectReviewMessages } from "./review-messages";

const EMPTY: readonly AgentThread[] = [];

/** One fetch/subscription per main transcript, never per card or per streamed token. */
export function useReviewMessages(messages: ChatMessage[], conversationId?: string | null): ChatMessage[] {
  const [state, setState] = useState<{ owner: string; threads: readonly AgentThread[] }>();
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    const adopt = (incoming: readonly AgentThread[]): void => {
      if (cancelled) return;
      setState((current) => {
        const owned = current?.owner === conversationId ? current.threads : EMPTY;
        const threads = mergeReviewThreads(owned, incoming, conversationId);
        return current?.owner === conversationId && current.threads === threads ? current : { owner: conversationId, threads };
      });
    };
    // Subscribe first: an older fetch response must not overwrite a completion push.
    const unsubscribe = onEvent((event) => {
      if (event.type === "agent_thread_changed" && event.conversationId === conversationId && event.thread) adopt([event.thread as AgentThread]);
    });
    void getAgentThreads(conversationId).then(adopt).catch(() => undefined);
    return () => { cancelled = true; unsubscribe(); };
  }, [conversationId]);
  const threads = state && state.owner === conversationId ? state.threads : EMPTY;
  return useMemo(() => projectReviewMessages(messages, threads, conversationId), [messages, threads, conversationId]);
}
