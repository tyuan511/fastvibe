import "react-native-gesture-handler";

import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { loadLanguagePreference, useT } from "../i18n";
import { loadPreferences } from "../ui/preferences";
import { DialogHost } from "../ui/dialog";
import { ToastHost } from "../ui/toast";
import { usePalette } from "../ui/theme";
import { UpdatePrompt } from "../update/update-banner";

// Held until the stored language and theme are applied (see `ready` below).
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  const palette = usePalette();
  const { t } = useT();
  // The language and theme are read before the first screen draws: a list that
  // flashes English and then redraws in 中文 (or light, then dark) reads as a glitch.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void Promise.all([loadLanguagePreference(), loadPreferences()]).finally(() => {
      setReady(true);
      SplashScreen.hide();
    });
  }, []);
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
