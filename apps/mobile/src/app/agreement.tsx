import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  runAgreement,
  type AgreementCase,
  type AgreementReport,
  type AgreementResult,
} from "@orbitwatch/orbit-core";

import fixture from "../../../../fixtures/cross-platform-agreement.json";
import { MONO, theme } from "@/lib/theme";

/**
 * Cross-platform agreement, run on this device.
 *
 * This is the half of the M6 gate that cannot be faked from a laptop. The native app
 * runs on Hermes, which is not V8: it hands several `Math` functions to the platform's
 * C library, so an Android phone, an iPhone and a desktop browser can each produce
 * slightly different digits from the same arithmetic. Everything else in this product
 * rests on the claim that they nonetheless agree about where to look, and this screen
 * is where that claim is checked against the engine actually shipping.
 *
 * The comparison is against the committed fixture, never against another platform. Two
 * platforms agreeing with each other proves nothing when both run the same library —
 * that is exactly the shape of a shared bug.
 *
 * It is a normal, shipped screen rather than a debug build artefact. A user who wants
 * to know whether to trust the numbers should be able to check, and the honest way to
 * answer "are these positions right" is to let someone run the test themselves.
 */

const suite = fixture as unknown as {
  anchor: string;
  cases: AgreementCase[];
  expected: AgreementResult[];
};

export default function AgreementScreen() {
  const [report, setReport] = useState<AgreementReport | undefined>(undefined);

  useEffect(() => {
    // Deferred a frame so the screen paints before roughly a second of SGP4 blocks the
    // JS thread. Running it in the render body would present as a frozen navigation.
    const timer = setTimeout(() => {
      setReport(runAgreement(suite.cases, suite.expected));
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "Agreement" }} />

      <Text style={styles.lead}>
        Every position in this app is computed here, on this device, from published
        orbital elements. This checks that this device agrees with every other platform
        about where things are.
      </Text>

      {report === undefined ? (
        <View style={styles.running}>
          <ActivityIndicator color={theme.accent} />
          <Text style={styles.note}>Propagating 16 cases…</Text>
        </View>
      ) : (
        <>
          <Text
            style={[styles.verdict, report.agreed ? styles.verdictOk : styles.verdictFail]}
            accessibilityLabel={
              report.agreed ? "Agreement confirmed" : "Disagreement detected"
            }
          >
            {report.agreed
              ? `Agreement confirmed across ${String(report.casesChecked)} cases and ${String(report.quantitiesChecked)} quantities.`
              : `Disagreement in ${String(report.deviations.length)} of ${String(report.quantitiesChecked)} quantities.`}
          </Text>

          <Text style={styles.note}>
            Largest deviation observed: {(report.worstRatio * 100).toPrecision(3)}% of the
            allowed tolerance.
          </Text>

          {report.deviations.slice(0, 12).map((deviation, index) => (
            <View key={index} style={styles.deviation}>
              <Text style={styles.deviationTitle}>
                {deviation.caseId} · {deviation.quantity}
              </Text>
              <Text style={styles.deviationBody}>
                expected {deviation.expected} · got {deviation.actual} · off by{" "}
                {deviation.difference.toExponential(3)}
              </Text>
            </View>
          ))}
        </>
      )}

      <Text style={styles.heading}>What is compared</Text>
      <Text style={styles.note}>
        Four real objects across four orbital regimes — low, medium, geostationary and
        highly elliptical — each against four observing locations chosen to stress the
        geometry: Sydney, the equator, inside the Arctic circle, and the antimeridian.
        Objects above a 225-minute period propagate through SDP4 rather than SGP4, so
        both models are covered.
      </Text>
      <Text style={styles.note}>
        For each, five instants across a day and a half are checked for latitude,
        longitude, altitude, azimuth, elevation and range, plus a 24-hour pass search
        compared on its acquisition, peak and loss times.
      </Text>

      <Text style={styles.heading}>Why not an exact match</Text>
      <Text style={styles.note}>
        This app runs on Hermes; the website runs on V8 or JavaScriptCore. Their maths
        libraries differ in the last few digits, which is not a fault in any of them. So
        agreement is defined physically: angles to a millionth of a degree, distances to
        a metre, pass times to a second. Each is far tighter than the accuracy of the
        orbital elements themselves.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.background },
  content: { padding: 16, gap: 12 },
  lead: { color: theme.text, fontSize: 14, lineHeight: 20 },
  running: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  verdict: {
    borderLeftWidth: 3,
    paddingLeft: 10,
    paddingVertical: 6,
    fontSize: 14,
    lineHeight: 19,
  },
  verdictOk: { borderLeftColor: theme.good, color: theme.good },
  verdictFail: { borderLeftColor: theme.bad, color: theme.bad },
  note: { color: theme.textMuted, fontSize: 12, lineHeight: 18 },
  heading: { color: theme.text, fontSize: 13, fontWeight: "600", marginTop: 8 },
  deviation: {
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    gap: 3,
  },
  deviationTitle: { color: theme.warn, fontSize: 11, fontFamily: MONO.default },
  deviationBody: { color: theme.textMuted, fontSize: 11, fontFamily: MONO.default },
});
