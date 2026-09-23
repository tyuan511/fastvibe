import { useEffect, useSyncExternalStore, type JSX } from "react";
import { Toaster } from "@/components/ui/sonner";
import { useThemeSync } from "@/lib/use-theme";
import { useLanguageSync } from "@/lib/use-language";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { ChatScreen } from "./chat-screen";
import { ConversationListScreen } from "./conversation-list";
import { refreshCatalog, showConversation, startLive } from "./live";
import { readRoute, subscribeRoute, type MobileRoute } from "./route";

/**
 * The phone page: a list of chats and one chat at a time.
 *
 * Not the desktop shell at a narrow width. The desktop's `App` is built around a window
 * — a sidebar, a side pane, a settings overlay, a composer with a dozen chips — and a
 * phone got all of it folded into drawers. This page keeps the two things a phone is
 * for, reading what an agent is doing and answering it, and reuses the desktop's own
 * transcript renderer, approval panel and session store for both, so a reply reads the
 * same on either screen.
 *
 * It is also a polite client: it never opens a conversation in the engine's sense (see
 * `live.ts`), so reading a chat on the phone does not move the desktop.
 */
export function MobileApp(): JSX.Element {
  useThemeSync();
  useLanguageSync();
  // A preference written on the desktop (theme, language) reaches this page too.
  useEffect(() => window.fastvibe.settings.onChanged((next) => useSettingsStore.getState().applyRemote(next)), []);

  const route = useSyncExternalStore(subscribeRoute, readRoute, readRoute);

  useEffect(() => {
    const stop = startLive();
    void refreshCatalog().catch(() => undefined);
    void window.fastvibe.engine
      .getModels()
      .then((models) => useSessionStore.getState().setModels(models))
      .catch(() => undefined);
    return stop;
  }, []);

  const conversationId = route.kind === "chat" ? route.id : null;
  useEffect(() => {
    // The send on the new-chat page shows its conversation itself, before its first
    // prompt goes out; the route catching up afterwards must not reload it from under
    // the optimistic row.
    if (conversationId && useSessionStore.getState().activeId === conversationId) return;
    void showConversation(conversationId);
  }, [conversationId]);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <Screen route={route} />
      <Toaster position="top-center" />
    </div>
  );
}

function Screen({ route }: { route: MobileRoute }): JSX.Element {
  if (route.kind === "chat") return <ChatScreen key={route.id} conversationId={route.id} />;
  if (route.kind === "new") return <ChatScreen key="new" conversationId={null} initialProject={route.project} />;
  return <ConversationListScreen />;
}
