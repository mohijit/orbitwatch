import { Tabs } from "expo-router";

import { theme } from "@/lib/theme";

/**
 * The four things this app is for: see the globe, find an object, keep a list, and
 * say where you are. Deliberately four — a fifth tab would be a place to put features
 * rather than a thing the user came to do.
 */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.background },
        headerTintColor: theme.text,
        tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.border },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textMuted,
        sceneStyle: { backgroundColor: theme.background },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Globe", headerShown: false }} />
      <Tabs.Screen name="search" options={{ title: "Search" }} />
      <Tabs.Screen name="watchlist" options={{ title: "Watchlist" }} />
      <Tabs.Screen name="observer" options={{ title: "Observer" }} />
    </Tabs>
  );
}
