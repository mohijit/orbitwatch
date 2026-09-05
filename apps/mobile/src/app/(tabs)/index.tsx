import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { theme } from "@/lib/theme";

/**
 * The globe tab.
 *
 * NOT YET THE GLOBE, AND IT SAYS SO
 * The renderer is a Cesium scene in a WebView (ADR-0003). Its HTML is written and
 * tested — `src/globe/scene-html.ts` — and the message protocol between native and
 * scene is defined and schema-checked in `@orbitwatch/contracts`. What is missing is
 * the build step that copies the Cesium bundle into the app's own assets so the scene
 * can load it from `file://` and work offline.
 *
 * That step is deliberately not faked. The alternative — pointing the WebView at a
 * CDN, or at the public website — would produce a globe that appears to work in a demo
 * and fails on a plane, and it would put a remote origin inside the bridge's security
 * boundary. Both are the kind of shortcut this product exists to avoid, so the screen
 * states what it is instead of pretending.
 *
 * Everything else in the app is complete and does not depend on this: search, detail
 * with live look angles and passes, watchlist and observer all work now.
 */
export default function GlobeScreen() {
  const router = useRouter();

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Globe</Text>
      <Text style={styles.body}>
        The 3-D globe is not in this build yet. Its scene and the native bridge are
        written; the Cesium runtime still has to be bundled into the app so it renders
        offline rather than from a remote origin.
      </Text>
      <Text style={styles.body}>
        Nothing else waits on it. Search the catalog, open an object and you get its
        position, element epoch, retrieval time, look angles and passes — all computed
        on this device.
      </Text>
      <Pressable
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        onPress={() => {
          router.push("/search");
        }}
        accessibilityRole="button"
      >
        <Text style={styles.buttonText}>Search the catalog</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.background,
    padding: 24,
    justifyContent: "center",
    gap: 14,
  },
  title: { color: theme.text, fontSize: 22, fontWeight: "600" },
  body: { color: theme.textMuted, fontSize: 14, lineHeight: 20 },
  button: {
    marginTop: 8,
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  pressed: { opacity: 0.7 },
  buttonText: { color: theme.background, fontSize: 15, fontWeight: "600" },
});
