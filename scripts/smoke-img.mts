/**
 * End-to-end smoke test against a real product-photo PDF.
 *
 * Two outcomes are accepted as healthy:
 *
 *   (A) Vision works: pipeline emits image_description items, no warnings.
 *       The descriptions are printed so we can eyeball their content.
 *   (B) Vision fails: pipeline emits no image_description items but the
 *       failure is surfaced on `result.warnings` (never silently swallowed)
 *       and the OCR/text chunks are not mis-tagged as image_description.
 *
 * Run with:  pnpm tsx scripts/smoke-img.mts <path-to-photo.pdf>
 */
import { existsSync, readFileSync } from "node:fs";

import { runPipeline } from "../lib/pipeline.ts";

const PDF_PATH = process.argv[2] ?? "/home/thansiya/Downloads/IMG_3603.pdf";
if (!existsSync(PDF_PATH)) {
  console.error(`smoke-img: PDF not found at ${PDF_PATH}; pass a path as argv[2]`);
  process.exit(2);
}
const buf = new Uint8Array(readFileSync(PDF_PATH));
const result = await runPipeline(buf);

console.log("stats:", JSON.stringify(result.stats, null, 2));
console.log("items by source:", {
  text: result.items.filter((i) => i.sourceType === "text").length,
  ocr: result.items.filter((i) => i.sourceType === "ocr").length,
  image_description: result.items.filter((i) => i.sourceType === "image_description").length,
});
console.log(`warnings: ${result.warnings.length}`);
for (const w of result.warnings) {
  console.log(`  page ${w.page} ${w.stage}: ${w.message.slice(0, 160)}`);
}

const imageItems = result.items.filter((i) => i.sourceType === "image_description");
for (const item of imageItems) {
  console.log(`\n--- image_description page ${item.page} (${item.text.length} chars) ---`);
  console.log(item.text.slice(0, 600) + (item.text.length > 600 ? "…" : ""));
}

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

assert(result.items.length > 0, "pipeline produced at least one item");

if (imageItems.length > 0) {
  // Outcome A: vision worked.
  assert(result.warnings.length === 0, "no warnings when vision succeeds");
  assert(
    imageItems.some((i) => /trimmer|box|beard/i.test(i.text)),
    "image description mentions trimmer / box / beard",
  );
} else {
  // Outcome B: vision failed.
  assert(
    result.warnings.some((w) => w.stage === "page-vision" || w.stage === "image-vision"),
    "vision failures are surfaced as warnings (not silently swallowed)",
  );
}

console.log("\nIMG_3603.pdf smoke test passed");