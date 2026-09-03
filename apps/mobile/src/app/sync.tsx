import { useNavigation } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import {
  createPairing,
  deletePairing,
  fetchPairedWatchlist,
  pushPairedWatchlist,
} from "@/lib/api";
import {
  clearSyncCode,
  loadSyncCode,
  loadWatchlist,
  saveSyncCode,
  saveWatchlist,
} from "@/lib/storage";
import { MONO, theme } from "@/lib/theme";

/**
 * Moving a watchlist to another device.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT SYNCS, AND WHAT NEVER WILL
 *
 * A list of catalog numbers. Not the observing location — that is a home address to
 * within a few metres, the Observer screen promises it stays on the device, and a
 * convenience feature is not a reason to go back on that. Not an account either: there
 * is no email address here and no password, because a watchlist does not warrant one.
 *
 * THE CODE IS THE WHOLE THING
 * Whoever holds it can read and replace the list, so the screen says so plainly rather
 * than presenting it as a harmless share link. The server generates it, stores only its
 * hash, and never sees it again except to look one up.
 *
 * SYNC IS MANUAL, AND THAT IS THE DESIGN
 * Two devices editing one list with no accounts and no clocks in common cannot be
 * merged correctly, and a background sync that silently picks a winner would delete
 * satellites somebody added. Send and receive are separate buttons, each says which
 * direction it goes and what it will overwrite, and the user decides.
 * ─────────────────────────────────────────────────────────────────────────────
 */

type Status =
  | { readonly kind: "idle" }
  | { readonly kind: "busy" }
  | { readonly kind: "done"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

export default function SyncScreen() {
  const navigation = useNavigation();
  const [code, setCode] = useState<string | undefined>(undefined);
  const [entered, setEntered] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    navigation.setOptions({ title: "Sync watchlist" });
  }, [navigation]);

  useEffect(() => {
    void loadSyncCode().then(setCode);
  }, []);

  const run = useCallback(async (work: () => Promise<string>) => {
    setStatus({ kind: "busy" });
    try {
      setStatus({ kind: "done", message: await work() });
    } catch (error) {
      setStatus({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const startSharing = useCallback(() => {
    void run(async () => {
      const watchlist = await loadWatchlist();
      const created = await createPairing(watchlist);
      await saveSyncCode(created.code);
      setCode(created.code);
      return `${watchlist.length} object${watchlist.length === 1 ? "" : "s"} uploaded.`;
    });
  }, [run]);

  const send = useCallback(() => {
    if (code === undefined) return;
    void run(async () => {
      const watchlist = await loadWatchlist();
      await pushPairedWatchlist(code, watchlist);
      return `Sent ${watchlist.length} object${watchlist.length === 1 ? "" : "s"}. The other device will see this list next time it receives.`;
    });
  }, [code, run]);

  const receive = useCallback(
    (useCode: string) => {
      void run(async () => {
        const remote = await fetchPairedWatchlist(useCode);
        // A replacement, not a merge. Merging would resurrect every satellite the user
        // had removed, every time the other device sent its copy.
        await saveWatchlist(remote.catalogIds);
        await saveSyncCode(useCode);
        setCode(useCode);
        setEntered("");
        return `This device now follows the ${remote.catalogIds.length} object${
          remote.catalogIds.length === 1 ? "" : "s"
        } from that code.`;
      });
    },
    [run],
  );

  const stop = useCallback(() => {
    if (code === undefined) return;
    void run(async () => {
      // Deletes what is stored, not just the local reference. Unpairing should leave
      // nothing behind on the server for a code that is no longer in use.
      await deletePairing(code);
      await clearSyncCode();
      setCode(undefined);
      return "Pairing deleted. Nothing of this watchlist is stored on the server.";
    });
  }, [code, run]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.note}>
          Only the list of satellites you follow is sent — catalog numbers and nothing
          else. Your observing location never leaves this device.
        </Text>
      </View>

      {code === undefined ? (
        <View style={styles.card}>
          <Text style={styles.label}>Share this watchlist</Text>
          <Text style={styles.note}>
            Creates a code you can type into another device. No account, no email.
          </Text>
          <Button label="Create a code" onPress={startSharing} busy={status.kind === "busy"} />
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.label}>Your code</Text>
          <Text style={styles.code} selectable accessibilityLabel={`Sync code ${code}`}>
            {code}
          </Text>
          <Text style={styles.warn}>
            Anyone with this code can read and replace this watchlist. Treat it like a
            password.
          </Text>
          <Button label="Send this device's list" onPress={send} busy={status.kind === "busy"} />
          <Button
            label="Receive into this device"
            onPress={() => {
              receive(code);
            }}
            busy={status.kind === "busy"}
            secondary
          />
          <Button label="Stop syncing and delete" onPress={stop} busy={status.kind === "busy"} secondary />
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.label}>Use a code from another device</Text>
        <TextInput
          style={styles.input}
          value={entered}
          onChangeText={setEntered}
          placeholder="ABCDE-FGHJK"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="characters"
          autoCorrect={false}
          accessibilityLabel="Sync code from another device"
        />
        <Text style={styles.warn}>
          This replaces the watchlist on this device with the one stored under that code.
        </Text>
        <Button
          label="Receive"
          onPress={() => {
            receive(entered.trim());
          }}
          busy={status.kind === "busy" || entered.trim() === ""}
        />
      </View>

      {status.kind === "done" ? <Text style={styles.done}>{status.message}</Text> : null}
      {status.kind === "failed" ? <Text style={styles.error}>{status.message}</Text> : null}
    </ScrollView>
  );
}

function Button({
  label,
  onPress,
  busy,
  secondary = false,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly busy: boolean;
  readonly secondary?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        secondary ? styles.secondary : styles.button,
        pressed && styles.pressed,
        busy && styles.disabled,
      ]}
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
    >
      <Text style={secondary ? styles.secondaryText : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.background },
  content: { padding: 12, gap: 12, paddingBottom: 40 },
  card: {
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 10,
  },
  label: { color: theme.textMuted, fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase" },
  note: { color: theme.textMuted, fontSize: 12, lineHeight: 17 },
  warn: { color: theme.warn, fontSize: 12, lineHeight: 17 },
  done: { color: theme.good, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 },
  error: { color: theme.bad, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 },
  code: {
    color: theme.accent,
    fontSize: 26,
    letterSpacing: 3,
    fontFamily: MONO.default,
    textAlign: "center",
    paddingVertical: 6,
  },
  input: {
    backgroundColor: theme.background,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 8,
    color: theme.text,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 17,
    letterSpacing: 2,
    fontFamily: MONO.default,
  },
  button: { backgroundColor: theme.accent, borderRadius: 8, paddingVertical: 11, alignItems: "center" },
  buttonText: { color: "#04121a", fontWeight: "600", fontSize: 14 },
  secondary: {
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: "center",
  },
  secondaryText: { color: theme.text, fontSize: 14 },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.45 },
});
