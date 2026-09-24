import { useEffect, useState, useSyncExternalStore, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { isBlockingPrompt } from "@shared/notifications";
import { Toaster } from "@/components/ui/sonner";
import { PermissionModeProvider } from "@/components/permission-mode-provider";
import { useThemeSync } from "@/lib/use-theme";
import { useLanguageSync } from "@/lib/use-language";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { ChatScreen } from "./chat-screen";
import { ConversationDrawer } from "./conversation-drawer";
import { refreshCatalog, showConversation, startLive } from "./live";
import { navigate, readRoute, subscribeRoute } from "./route";

/**
 * The phone page: one chat at a time, with every other chat a drawer away.
 *
 * Not the desktop shell at a narrow width. The desktop's `App` is built around a window
 * — a sidebar, a side pane, a settings overlay, a composer with a dozen chips — and a
 * phone got all of it folded into drawers. This page keeps what a phone is for — reading
 * what an agent is doing, answering it, starting and steering chats — and reuses the
 * desktop's own transcript renderer, approval panel and session store for it, so a
 * reply reads the same on either screen.
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
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const stop = startLive();
    void refreshCatalog().catch(() => undefined);
    void window.fastvibe.engine
      .getModels()
      .then((models) => useSessionStore.getState().setModels(models))
      .catch(() => undefined);
    return stop;
  }, []);

  useOtherChatNotices();

  const conversationId = route.kind === "chat" ? route.id : null;
  useEffect(() => {
    // The send on the new-chat page shows its conversation itself, before its first
    // prompt goes out; the route catching up afterwards must not reload it from under
    // the optimistic row.
    if (conversationId && useSessionStore.getState().activeId === conversationId) return;
    void showConversation(conversationId);
  }, [conversationId]);

  return (
    <PermissionModeProvider>
      <div className="flex h-full flex-col bg-background text-foreground">
        {route.kind === "chat" ? (
          <ChatScreen key={route.id} conversationId={route.id} onOpenDrawer={() => setDrawerOpen(true)} />
        ) : (
          <ChatScreen
            key={`new:${route.project ?? ""}`}
            conversationId={null}
            initialProject={route.project}
            onOpenDrawer={() => setDrawerOpen(true)}
          />
        )}
        <ConversationDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
        <Toaster position="top-center" />
      </div>
    </PermissionModeProvider>
  );
}

/**
 * Say so when another chat needs you, or has finished.
 *
 * The drawer marks both, but a drawer has to be opened to be read. The desktop raises a
 * system notification for the same two moments; a web page cannot do that reliably on a
 * phone (iOS allows it only from a home-screen app), so it is a toast with the way there.
 * The chat on screen raises nothing: its panel and its footer already say it.
 */
function useOtherChatNotices(): void {
  const { t } = useTranslation("app");
  useEffect(() => {
    const titleOf = (id: string): string =>
      useSessionStore.getState().conversations.find((item) => item.id === id)?.title || t("mobile.untitled");
    const open = (id: string): void => navigate({ kind: "chat", id });

    const offEvent = window.fastvibe.engine.onEvent((event) => {
      const id = typeof event.conversationId === "string" ? event.conversationId : null;
      if (!id || id === useSessionStore.getState().activeId) return;
      if (event.type === "extension_ui_request" && isBlockingPrompt(event)) {
        toast.warning(t("mobile.needsYou", { title: titleOf(id) }), {
          id: `needs:${id}`,
          action: { label: t("mobile.view"), onClick: () => open(id) },
        });
      }
    });

    // Finished is read off the busy map rather than an event: `conversation_activity` is
    // only emitted for chats the desktop is not showing, and the phone's idea of "another
    // chat" is a different set.
    let previous = useSessionStore.getState().running;
    const offRunning = useSessionStore.subscribe((state) => {
      const current = state.running;
      if (current === previous) return;
      for (const [id, was] of Object.entries(previous)) {
        if (!was || current[id] || id === state.activeId) continue;
        // A chat that stopped because it is waiting on the user is not finished.
        if (state.waitingForUser[id]) continue;
        toast(t("mobile.finished", { title: titleOf(id) }), {
          id: `finished:${id}`,
          action: { label: t("mobile.view"), onClick: () => open(id) },
        });
      }
      previous = current;
    });

    return () => {
      offEvent();
      offRunning();
    };
  }, [t]);
}
