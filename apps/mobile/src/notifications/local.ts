import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { t } from "../i18n";
import { currentConnection, onEngineEvent } from "../session/connection";
import { currentPreferences, setPreference } from "../ui/preferences";
import { mobileNoticeForEvent, notificationTarget, type MobileNotice } from "./policy";

const CHANNEL_ID = "fastvibe-activity";
const seenKeys = new Set<string>();

export type OpenNotificationTarget = (target: { serverId: string; conversationId: string }) => void | Promise<void>;

/**
 * Install the phone's local-notification bridge once from the root layout.
 *
 * This deliberately listens to the already-authenticated engine stream rather than
 * creating a second connection. It is therefore useful while the app is backgrounded
 * but cannot wake a process that the OS has suspended or killed; remote push is a later
 * phase of the feature.
 */
export function installLocalNotifications(onOpen: OpenNotificationTarget): () => void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });

  void prepareNotifications();

  const stopEvents = onEngineEvent((event) => {
    const connection = currentConnection();
    const notice = mobileNoticeForEvent(event, {
      background: AppState.currentState !== "active",
      enabled: currentPreferences().notifications,
      serverId: connection.server?.id ?? "",
      conversations: connection.conversations,
      archivedIds: connection.archivedIds,
      permissionAlways: connection.permissionAlways,
    });
    if (!notice || (notice.key && seenKeys.has(notice.key))) return;
    if (notice.key) {
      seenKeys.add(notice.key);
      if (seenKeys.size > 1000) {
        const first = seenKeys.values().next().value;
        if (typeof first === "string") seenKeys.delete(first);
      }
    }
    void presentNotice(notice, connection.server?.id ?? "");
  });

  const responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const target = notificationTarget(response.notification.request.content.data);
    if (!target || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    void onOpen(target);
    Notifications.clearLastNotificationResponse();
  });

  // A cold-start tap can be available before the response listener is attached.
  try {
    const response = Notifications.getLastNotificationResponse();
    if (response) {
      const target = notificationTarget(response.notification.request.content.data);
      if (target && response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) {
        void onOpen(target);
        Notifications.clearLastNotificationResponse();
      }
    }
  } catch {
    // Expo Go and web may not expose a native last-response store.
  }

  return () => {
    stopEvents();
    responseSubscription.remove();
  };
}

/** Ask for notification permission when the feature is enabled. */
export async function enableLocalNotifications(): Promise<boolean> {
  await setPreference("notifications", true);
  const granted = await requestPermission();
  if (!granted) await setPreference("notifications", false);
  return granted;
}

async function prepareNotifications(): Promise<void> {
  if (!currentPreferences().notifications) return;
  const granted = await requestPermission();
  if (!granted) await setPreference("notifications", false);
}

async function requestPermission(): Promise<boolean> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return false;
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: t("notifications.channel"),
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 200, 100, 200],
        sound: "default",
      });
    }
    const current = await Notifications.getPermissionsAsync();
    if (current.granted || current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) return true;
    const next = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: false, allowSound: true },
    });
    return next.granted || next.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  } catch {
    return false;
  }
}

async function presentNotice(notice: MobileNotice, serverId: string): Promise<void> {
  if (!serverId) return;
  const connection = currentConnection();
  const conversation = connection.conversations.find((item) => item.id === notice.conversationId);
  const title = notice.kind === "approval"
    ? t("notifications.waitingTitle")
    : notice.title || conversation?.title || t("common.conversation");
  const body = notice.kind === "approval"
    ? t("notifications.waitingBody")
    : notice.kind === "error"
      ? t("notifications.errorBody")
      : t("notifications.doneBody");
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: notice.key,
      content: {
        title,
        body,
        sound: "default",
        data: { type: "fastvibe.chat", serverId, conversationId: notice.conversationId },
      },
      trigger: Platform.OS === "android" ? { channelId: CHANNEL_ID } : null,
    });
  } catch {
    // Notification presentation is best effort; the live event remains available in-app.
  }
}
