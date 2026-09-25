import "react-native-gesture-handler";

import { StatusBar } from "expo-status-bar";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <SafeAreaProvider>
      <StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
      <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
        <Stack>
          <Stack.Screen name="index" options={{ title: "设备" }} />
          <Stack.Screen name="add" options={{ title: "添加设备" }} />
          <Stack.Screen name="scan" options={{ title: "扫码" }} />
          <Stack.Screen name="server/[id]" options={{ title: "设备" }} />
          <Stack.Screen name="chat/[conversationId]" options={{ title: "会话" }} />
        </Stack>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
