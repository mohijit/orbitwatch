import { PointCloudBench } from "@/components/globe/point-cloud-bench";

/**
 * Renderer benchmark harness (Milestone 0).
 *
 * Not part of the product surface — it exists so the point-cloud rendering strategy
 * is chosen from measurements rather than assumption. Driven by Playwright.
 */
export default function BenchPage() {
  return <PointCloudBench />;
}
