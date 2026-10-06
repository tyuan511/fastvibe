import "react-native-gesture-handler";

import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { loadLanguagePreference, useT } from "../i18n";
import { connectSaved, currentConnection } from "../session/connection";
import { loadServers } from "../storage/servers";
import { loadPreferences } from "../ui/preferences";
import { DialogHost } from "../ui/dialog";
import { ToastHost } from "../ui/toast";
import { usePalette } from "../ui/theme";
import { UpdatePrompt } from "../update/update-banner";
import { installLocalNotifications } from "../notifications/local";

// Held until the stored language and theme are applied (see `ready` below).
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  const palette = usePalette();
  const { t } = useT();
  const router = useRouter();
  // The language and theme are read before the first screen draws: a list that
  // flashes English and then redraws in 中文 (or light, then dark) reads as a glitch.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void Promise.all([loadLanguagePreference(), loadPreferences()]).finally(() => {
      setReady(true);
      SplashScreen.hide();
    });
  }, []);

  const openNotificationTarget = useCallback(async (target: { serverId: string; conversationId: string }) => {
    const current = currentConnection();
    if (current.server?.id !== target.serverId || current.status === "error") {
      const server = (await loadServers()).find((item) => item.id === target.serverId);
      if (!server) {
        router.replace("/");
        return;
      }
      await connectSaved(server);
    }
    const next = currentConnection();
    if (next.server?.id === target.serverId && next.status === "ready") {
      router.push(`/chat/${target.conversationId}`);
    } else {
      router.push(`/server/${target.serverId}`);
    }
  }, [router]);

  useEffect(() => {
    if (!ready) return undefined;
    return installLocalNotifications(openNotificationTarget);
  }, [ready, openNotificationTarget]);
  // The navigator's own theme, from the same tokens as the screens — its default
  // white header over a grey grouped page read as two different apps.
  const theme = useMemo(() => {
    const base = palette.dark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: palette.accent,
        background: palette.background,
        card: palette.background,
        text: palette.text,
        border: palette.border,
        notification: palette.danger,
      },
    };
  }, [palette]);

  if (!ready) return null;

  return (
    <SafeAreaProvider>
      <StatusBar style={palette.dark ? "light" : "dark"} />
      <ThemeProvider value={theme}>
        <Stack
          screenOptions={{
            headerShadowVisible: false,
            headerStyle: { backgroundColor: palette.background },
            headerTitleStyle: { fontWeight: "700", color: palette.text },
            headerTintColor: palette.accent,
            headerBackButtonDisplayMode: "minimal",
            contentStyle: { backgroundColor: palette.background },
          }}
        >
          <Stack.Screen name="index" options={{ title: "FastVibe" }} />
          <Stack.Screen name="add" options={{ title: t("nav.addDevice") }} />
          <Stack.Screen name="scan" options={{ title: t("nav.scan") }} />
          <Stack.Screen name="settings" options={{ title: t("nav.settings") }} />
          <Stack.Screen name="server/[id]" options={{ title: t("common.device") }} />
          <Stack.Screen name="chat/[conversationId]" options={{ title: t("common.conversation") }} />
        </Stack>
        <DialogHost />
        <ToastHost />
        <UpdatePrompt />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
