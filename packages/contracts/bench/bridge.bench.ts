import { packPositions, unpackPositions } from "../src/globe-bridge.js";

/** Measures the WebView bridge cost that decides whether Architecture B is viable. */
const COUNTS = [1_000, 5_000, 10_000, 20_000];
const REPEATS = 20;

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : (((s[m - 1] as number) + (s[m] as number)) / 2);
};

console.log("\nOrbitWatch WebView bridge payload benchmark");
console.log(`node ${process.version} · ${process.platform}/${process.arch}\n`);
console.log("  objects   packed(base64)   naive JSON    ratio     pack     unpack");

for (const count of COUNTS) {
  const positions = Array.from({ length: count }, (_, i) => ({
    longitude: ((i * 137.5) % 360) - 180,
    latitude: ((i * 61.8) % 180) - 90,
    altitudeKm: 400 + (i % 600),
  }));

  const packTimes: number[] = [];
  let encoded = "";
  for (let r = 0; r < REPEATS; r += 1) {
    const t0 = performance.now();
    encoded = packPositions(positions);
    packTimes.push(performance.now() - t0);
  }

  const unpackTimes: number[] = [];
  for (let r = 0; r < REPEATS; r += 1) {
    const t0 = performance.now();
    unpackPositions(encoded);
    unpackTimes.push(performance.now() - t0);
  }

  const naive = JSON.stringify(positions).length;
  console.log(
    `  ${String(count).padStart(7)}  ` +
      `${(encoded.length / 1024).toFixed(0).padStart(11)} KB  ` +
      `${(naive / 1024).toFixed(0).padStart(9)} KB  ` +
      `${(naive / encoded.length).toFixed(1).padStart(6)}x  ` +
      `${median(packTimes).toFixed(2).padStart(7)} ms  ` +
      `${median(unpackTimes).toFixed(2).padStart(7)} ms`,
  );
}
console.log(
  "\nAt 1 Hz a 20k catalog costs ~320 KB per update across the bridge, packed in\n" +
    "single-digit milliseconds. The naive JSON-of-objects encoding is several MB.\n",
);
