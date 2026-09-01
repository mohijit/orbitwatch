import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { Satellite } from "@orbitwatch/contracts";

import { fetchSatellites } from "@/lib/api";
import { MONO, theme } from "@/lib/theme";

/**
 * Catalog search.
 *
 * DEBOUNCED, AND CANCELLED
 * Every keystroke would otherwise be a request, and on a mobile connection the
 * responses arrive out of order — so the list would flicker between results for
 * "IS", "ISS" and "IS" again. The debounce cuts the request count; the sequence guard
 * is what actually fixes correctness, by discarding any response that is not the
 * newest one asked for.
 *
 * A FAILURE IS NOT AN EMPTY LIST
 * "No results" and "the request failed" look identical if both render as an empty
 * list, and on a phone the second is common. They are separate states here.
 */

const DEBOUNCE_MS = 250;
const PAGE_SIZE = 50;

type SearchState =
  | { readonly status: "idle" }
  | { readonly status: "searching" }
  | { readonly status: "ready"; readonly results: readonly Satellite[]; readonly total: number }
  | { readonly status: "failed"; readonly message: string };

export default function SearchScreen() {
  const router = useRouter();
  const [term, setTerm] = useState("");
  const [state, setState] = useState<SearchState>({ status: "idle" });

  // Monotonic request id. Only the newest response is allowed to update state.
  const requestId = useRef(0);

  useEffect(() => {
    const trimmed = term.trim();
    if (trimmed === "") {
      setState({ status: "idle" });
      return;
    }

    const id = requestId.current + 1;
    requestId.current = id;
    setState({ status: "searching" });

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetchSatellites({ search: trimmed, limit: PAGE_SIZE });
          if (requestId.current !== id) return;
          setState({ status: "ready", results: response.satellites, total: response.total });
        } catch (error) {
          if (requestId.current !== id) return;
          setState({
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [term]);

  const open = useCallback(
    (catalogId: string) => {
      router.push(`/satellite/${catalogId}`);
    },
    [router],
  );

  return (
    <View style={styles.screen}>
      <TextInput
        style={styles.input}
        value={term}
        onChangeText={setTerm}
        placeholder="Search by name or catalog number"
        placeholderTextColor={theme.textMuted}
        autoCorrect={false}
        autoCapitalize="characters"
        returnKeyType="search"
        accessibilityLabel="Search satellites"
      />

      {state.status === "idle" ? (
        <Text style={styles.hint}>
          Search the catalog by name (ISS, HUBBLE, STARLINK) or by NORAD catalog number.
        </Text>
      ) : null}

      {state.status === "searching" ? <ActivityIndicator color={theme.accent} /> : null}

      {state.status === "failed" ? (
        <Text style={styles.error}>
          {state.message}
          {"\n"}
          The catalog could not be reached. This is a connection problem, not an empty
          catalog.
        </Text>
      ) : null}

      {state.status === "ready" ? (
        state.results.length === 0 ? (
          <Text style={styles.hint}>No object in the catalog matches that.</Text>
        ) : (
          <FlatList
            data={state.results}
            keyExtractor={(item) => item.catalogId}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              <Text style={styles.count}>
                {state.total > state.results.length
                  ? `${String(state.results.length)} of ${String(state.total)} matches`
                  : `${String(state.total)} ${state.total === 1 ? "match" : "matches"}`}
              </Text>
            }
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => {
                  open(item.catalogId);
                }}
                accessibilityRole="button"
                accessibilityLabel={`${item.name}, catalog number ${item.catalogId}`}
              >
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.meta}>
                  #{item.catalogId}
                  {item.orbitClass === undefined ? "" : ` · ${item.orbitClass}`}
                </Text>
              </Pressable>
            )}
          />
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.background, padding: 12, gap: 10 },
  input: {
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 8,
    color: theme.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  hint: { color: theme.textMuted, fontSize: 13, lineHeight: 18 },
  error: { color: theme.bad, fontSize: 13, lineHeight: 18 },
  count: { color: theme.textMuted, fontSize: 11, marginBottom: 6 },
  row: {
    paddingVertical: 10,
    borderBottomColor: theme.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowPressed: { opacity: 0.6 },
  name: { color: theme.text, fontSize: 15 },
  meta: { color: theme.textMuted, fontSize: 12, fontFamily: MONO.default, marginTop: 2 },
});
