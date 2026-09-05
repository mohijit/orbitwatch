import { DeviceBench } from "@/components/globe/device-bench";

/**
 * On-device render benchmark (Milestone 8.5).
 *
 * Opened by hand on a real phone, over the LAN, against a production build. Its output
 * is the evidence behind `docs/adr/0006-mobile-web-performance.md`: whether a phone can
 * hold a usable frame rate while drawing the whole catalog, and what removing the
 * per-frame style writes was actually worth.
 *
 * Deliberately not linked from anywhere in the app, and deliberately not run in CI —
 * headless Chromium rasterises on the CPU, so the one number this page exists to
 * produce would be a measurement of SwiftShader.
 */
export default function DeviceBenchPage() {
  return <DeviceBench />;
}
