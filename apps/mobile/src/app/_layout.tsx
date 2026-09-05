import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { theme } from "@/lib/theme";

/**
 * Root navigation.
 *
 * A Stack wrapping the tab group, so a satellite detail screen pushes over the tabs
 * rather than replacing them — the user returns to whatever they were looking at,
 * including the globe's camera position, which is expensive to rebuild.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.background },
          headerTintColor: theme.text,
          headerTitleStyle: { fontSize: 16 },
          contentStyle: { backgroundColor: theme.background },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="satellite/[catalogId]" options={{ title: "Satellite" }} />
      </Stack>
    </SafeAreaProvider>
  );
}
