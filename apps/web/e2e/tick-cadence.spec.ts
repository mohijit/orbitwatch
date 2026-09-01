import { expect, test } from "@playwright/test";

/**
 * Measures how often the propagation worker is actually driven in LIVE mode.
 *
 * Instruments the Worker interface from an init script rather than the app, so this
 * observes exactly the code that ships. Both directions are recorded: `tick` messages
 * posted to the worker, and `positions` buffers coming back.
 */

const OBSERVE_MS = 12_000;
const EXPECTED_HZ = 1;

interface TickLog {
  readonly ticks: number[];
  readonly positions: number[];
}

test("drives the propagation worker at a steady 1 Hz in LIVE mode", async ({ page }) => {
  await page.addInitScript(() => {
    const log: TickLog = { ticks: [], positions: [] };
    (window as unknown as { __tickLog: TickLog }).__tickLog = log;

    const Base = window.Worker;
    class InstrumentedWorker extends Base {
      constructor(scriptUrl: string | URL, options?: WorkerOptions) {
        super(scriptUrl, options);
        this.addEventListener("message", (event: MessageEvent) => {
          if ((event.data as { type?: string } | null)?.type === "positions") {
            log.positions.push(performance.now());
          }
        });
      }
      override postMessage(message: unknown, ...rest: unknown[]): void {
        if ((message as { type?: string } | null)?.type === "tick") {
          log.ticks.push(performance.now());
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (Base.prototype.postMessage as any).call(this, message, ...rest);
      }
    }
    window.Worker = InstrumentedWorker as unknown as typeof Worker;
  });

  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toContainText("OBJECTS", { timeout: 60_000 });

  await page.waitForTimeout(OBSERVE_MS);

  const log = await page.evaluate(
    () => (window as unknown as { __tickLog: TickLog }).__tickLog,
  );

  const gaps = (stamps: number[]): number[] =>
    stamps.slice(1).map((value, index) => Math.round(value - (stamps[index] as number)));

  const tickGaps = gaps(log.ticks);
  const positionGaps = gaps(log.positions);
  const worstGap = positionGaps.length > 0 ? Math.max(...positionGaps) : Infinity;

  console.log("\n=== propagation tick cadence (LIVE) ===");
  console.log(`  observed for       ${OBSERVE_MS} ms`);
  console.log(`  ticks posted       ${log.ticks.length}`);
  console.log(`  position frames    ${log.positions.length}`);
  console.log(`  tick gaps (ms)     ${JSON.stringify(tickGaps)}`);
  console.log(`  position gaps (ms) ${JSON.stringify(positionGaps)}`);
  console.log(`  worst position gap ${worstGap} ms\n`);

  // Allow one lost update at the edges of the observation window, but no more: a
  // position frame arriving late is exactly what the renderer extrapolates through,
  // and past MAX_EXTRAPOLATION_SECONDS it freezes and then jumps.
  const expected = Math.floor((OBSERVE_MS / 1000) * EXPECTED_HZ) - 1;
  expect(log.positions.length).toBeGreaterThanOrEqual(expected);
  expect(worstGap).toBeLessThan(2500);
});
