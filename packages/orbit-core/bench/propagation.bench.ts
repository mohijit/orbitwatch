/**
 * Propagation throughput benchmark.
 *
 * Answers the question both renderer decisions depend on: how many objects can we
 * propagate, how often, and does the WASM bulk path earn its complexity?
 *
 * ON THE ELEMENT SETS USED
 * Built from the REAL element sets in the Vallado SGP4 verification suite, cycled to
 * reach the requested object count. This is a COMPUTE benchmark: SGP4 cost depends on
 * orbit regime and time-from-epoch, not on whether an element set is currently in the
 * public catalog. These synthetic multiples are never rendered, never persisted, and
 * never presented as catalog data.
 *
 * WHY NEAR-EARTH AND DEEP-SPACE ARE MEASURED SEPARATELY
 * SGP4 (near-Earth, period < 225 min) is analytic: cost is constant regardless of how
 * far you propagate. SDP4 (deep-space) runs an iterative secular integrator that steps
 * forward from the element epoch, so its cost grows with TIME SINCE EPOCH. Propagating
 * a 2000-era deep-space element set to 2026 costs ~10 ms per object — about 1000x a
 * near-Earth propagation. Averaging the two produces a meaningless number, and a
 * catalog-wide average would hide a real product risk in the time-machine feature.
 *
 * Run with:  pnpm --filter @orbitwatch/orbit-core bench
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BulkPropagator,
  EciBaseCalculator,
  createSingleThreadRuntime,
  invjday,
  propagate,
  twoline2satrec,
  type SatRec,
} from "satellite.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures");

/** Object counts to measure. 20k is roughly the size of the tracked public catalog. */
const OBJECT_COUNTS = [1_000, 5_000, 10_000, 20_000] as const;

/** Repeats per measurement, after a warm-up pass. Median is reported. */
const REPEATS = 5;

/**
 * How far past epoch the representative measurement propagates.
 *
 * Production elements are at most a few hours old (CelesTrak publishes every ~2h), so
 * 90 minutes is a realistic worst case for the live view.
 */
const REALISTIC_AGE_MINUTES = 90;

interface Catalog {
  readonly label: string;
  readonly satrecs: SatRec[];
  /** Propagation target, chosen relative to the element epochs. */
  readonly when: Date;
  readonly note: string;
}

function loadBaseSatrecs(): SatRec[] {
  const raw = readFileSync(join(FIXTURE_DIR, "SGP4-VER.TLE"), "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => !line.startsWith("#"));

  const satrecs: SatRec[] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line1 = lines[index];
    const line2 = lines[index + 1];
    if (line1?.startsWith("1 ") !== true || line2?.startsWith("2 ") !== true) continue;
    try {
      const satrec = twoline2satrec(line1, line2);
      if (satrec.error === 0) satrecs.push(satrec);
    } catch {
      // Verification suite contains deliberately-invalid cases; skip them.
    }
    index += 1;
  }
  return satrecs;
}

/** Replicate base records up to `count`, preserving their initialised state. */
function replicate(base: readonly SatRec[], count: number): SatRec[] {
  if (base.length === 0) throw new Error("no usable base element sets");
  const catalog: SatRec[] = new Array<SatRec>(count);
  for (let index = 0; index < count; index += 1) {
    // Shallow clone so each object owns its per-propagation scratch fields.
    catalog[index] = { ...(base[index % base.length] as SatRec) };
  }
  return catalog;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function benchmarkJs(catalog: readonly SatRec[], when: Date): number {
  for (const satrec of catalog) propagate(satrec, when); // warm-up
  const samples: number[] = [];
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const started = performance.now();
    for (const satrec of catalog) propagate(satrec, when);
    samples.push(performance.now() - started);
  }
  return median(samples);
}

async function benchmarkWasm(catalog: SatRec[], when: Date): Promise<number> {
  const runtime = await createSingleThreadRuntime();
  // BulkPropagator allocates native memory and MUST be disposed or the WASM heap leaks.
  const propagator = new BulkPropagator({
    runtime,
    calculators: [new EciBaseCalculator()],
    satRecsCount: catalog.length,
    datesCount: 1,
  });

  try {
    propagator.setSatRecs(catalog);
    propagator.setDates([when]);
    propagator.run({}); // warm-up

    const samples: number[] = [];
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const started = performance.now();
      propagator.run({});
      samples.push(performance.now() - started);
    }
    return median(samples);
  } finally {
    propagator.dispose();
  }
}

function epochOf(satrec: SatRec): Date {
  return invjday(satrec.jdsatepoch);
}

async function runScenario(catalog: Catalog): Promise<void> {
  console.log(`\n=== ${catalog.label} ===`);
  console.log(`${catalog.note}\n`);
  console.log(
    "   objects        JS median      WASM median     speedup   WASM per object",
  );

  for (const count of OBJECT_COUNTS) {
    const objects = replicate(catalog.satrecs, count);
    const jsMs = benchmarkJs(objects, catalog.when);
    const wasmMs = await benchmarkWasm(objects, catalog.when);

    console.log(
      `  ${String(count).padStart(8)}  ` +
        `${jsMs.toFixed(2).padStart(12)} ms  ` +
        `${wasmMs.toFixed(2).padStart(12)} ms  ` +
        `${(jsMs / wasmMs).toFixed(1).padStart(8)}x  ` +
        `${((wasmMs / count) * 1000).toFixed(2).padStart(10)} us`,
    );
  }
}

async function main(): Promise<void> {
  const base = loadBaseSatrecs();
  const nearEarth = base.filter((satrec) => satrec.method === "n");
  const deepSpace = base.filter((satrec) => satrec.method === "d");

  console.log("\nOrbitWatch propagation benchmark");
  console.log(`node ${process.version} · ${process.platform}/${process.arch}`);
  console.log(
    `base element sets: ${base.length} real records ` +
      `(${nearEarth.length} near-Earth, ${deepSpace.length} deep-space)`,
  );
  console.log(`repeats per measurement: ${REPEATS} (median reported)`);

  // Representative production workload: near-Earth objects, fresh elements. The real
  // catalog is overwhelmingly LEO, and ingested elements are at most a few hours old.
  const nearEarthEpoch = epochOf(nearEarth[0] as SatRec);
  await runScenario({
    label: "A. Near-Earth, fresh elements (production case)",
    satrecs: nearEarth,
    when: new Date(nearEarthEpoch.getTime() + REALISTIC_AGE_MINUTES * 60_000),
    note:
      `Near-Earth SGP4, propagated ${REALISTIC_AGE_MINUTES} min past epoch. This is ` +
      `what the live globe actually does.`,
  });

  // Same objects, propagated 26 years past epoch. Near-Earth SGP4 is analytic, so
  // this should cost the same — confirming the regime distinction.
  await runScenario({
    label: "B. Near-Earth, 26 years past epoch",
    satrecs: nearEarth,
    when: new Date("2026-08-31T12:00:00Z"),
    note: "Confirms near-Earth cost is independent of time-from-epoch.",
  });

  // Deep-space, fresh elements: the iterative integrator has little to do.
  const deepSpaceEpoch = epochOf(deepSpace[0] as SatRec);
  await runScenario({
    label: "C. Deep-space, fresh elements",
    satrecs: deepSpace,
    when: new Date(deepSpaceEpoch.getTime() + REALISTIC_AGE_MINUTES * 60_000),
    note: "Deep-space SDP4 near epoch. Still more expensive than near-Earth.",
  });

  console.log("\n=== D. Deep-space degradation with time-from-epoch ===");
  console.log(
    "SDP4 integrates forward from epoch, so cost grows with how far you propagate.\n" +
      "This is the risk behind the time-machine feature, not the live view.\n",
  );
  console.log("   days past epoch     JS per object");
  const singleDeepSpace = replicate(deepSpace, 200);
  for (const days of [0, 1, 30, 365, 3650]) {
    const when = new Date(deepSpaceEpoch.getTime() + days * 86_400_000);
    const ms = benchmarkJs(singleDeepSpace, when);
    console.log(
      `  ${String(days).padStart(15)}  ${((ms / 200) * 1000).toFixed(1).padStart(12)} us`,
    );
  }

  console.log(
    "\nInterpretation\n" +
      "  - Whole-catalog propagation belongs off the render thread, updated at a low\n" +
      "    rate with interpolation driving the 60 fps loop.\n" +
      "  - The WASM bulk path is what makes 20k objects affordable.\n" +
      "  - Deep-space objects propagated far from epoch are the one pathological case;\n" +
      "    the live view never hits it, but unbounded time travel would.\n",
  );
}

await main();
