import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";

import { fetchElements } from "@/lib/api";
import { loadWatchlist, saveWatchlist } from "@/lib/storage";
import { MONO, theme } from "@/lib/theme";

/**
 * The objects this user cares about.
 *
 * The list itself is just catalog numbers on the device; names come from the API. That
 * ordering matters offline: if the network is gone the watchlist is still THERE, shown
 * by number, rather than appearing empty because the lookup failed. A watchlist that
 * silently empties itself on a train is worse than one that is briefly less legible.
 *
 * Reloaded on focus rather than once on mount, because the detail screen is where
 * things are added and removed, and returning from it must show the result.
 */

interface Entry {
  readonly catalogId: string;
  readonly name: string | undefined;
}

export default function WatchlistScreen() {
  const router = useRouter();
  const [entries, setEntries] = useState<readonly Entry[] | undefined>(undefined);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      void (async () => {
        const ids = await loadWatchlist();
        if (cancelled) return;
        // Numbers first, so the list renders immediately and completely.
        setEntries(ids.map((catalogId) => ({ catalogId, name: undefined })));

        const named = await Promise.all(
          ids.map(async (catalogId) => {
            try {
              const response = await fetchElements(catalogId);
              const raw = (response.elements.omm as { OBJECT_NAME?: unknown }).OBJECT_NAME;
              return {
                catalogId,
                name: typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined,
              };
            } catch {
              // Offline, or that object is no longer served. Keep the row.
              return { catalogId, name: undefined };
            }
          }),
        );
        if (!cancelled) setEntries(named);
      })();

      return () => {
        cancelled = true;
      };
    }, []),
  );

  const remove = useCallback(async (catalogId: string) => {
    const next = (await loadWatchlist()).filter((entry) => entry !== catalogId);
    await saveWatchlist(next);
    setEntries((current) => current?.filter((entry) => entry.catalogId !== catalogId));
  }, []);

  if (entries === undefined) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  if (entries.length === 0) {
    return (
      <View style={styles.centre}>
        <Text style={styles.empty}>
          Nothing watched yet. Open a satellite from Search and tap Watch to keep it
          here.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      data={entries}
      keyExtractor={(item) => item.catalogId}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <Pressable
            style={styles.rowMain}
            onPress={() => {
              router.push(`/satellite/${item.catalogId}`);
            }}
            accessibilityRole="button"
            accessibilityLabel={item.name ?? `Catalog number ${item.catalogId}`}
          >
            <Text style={styles.name}>{item.name ?? `#${item.catalogId}`}</Text>
            {item.name === undefined ? (
              <Text style={styles.meta}>Name unavailable offline</Text>
            ) : (
              <Text style={styles.meta}>#{item.catalogId}</Text>
            )}
          </Pressable>
          <Pressable
            onPress={() => {
              void remove(item.catalogId);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${item.name ?? item.catalogId} from watchlist`}
            hitSlop={10}
          >
            <Text style={styles.remove}>Remove</Text>
          </Pressable>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.background },
  content: { padding: 12 },
  centre: { flex: 1, backgroundColor: theme.background, alignItems: "center", justifyContent: "center", padding: 24 },
  empty: { color: theme.textMuted, fontSize: 13, textAlign: "center", lineHeight: 19 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 11,
    borderBottomColor: theme.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowMain: { flex: 1 },
  name: { color: theme.text, fontSize: 15 },
  meta: { color: theme.textMuted, fontSize: 12, fontFamily: MONO.default, marginTop: 2 },
  remove: { color: theme.textMuted, fontSize: 12 },
});
