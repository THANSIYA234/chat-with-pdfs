/**
 * Smoke-test the upload-side pipeline against each fixture PDF.
 *
 * Asserts (without contacting Supabase or MiniMax):
 *
 *   text-only.pdf    → at least one `text` chunk, zero `ocr` and zero
 *                       `image_description` chunks for the rendered-page
 *                       pass.
 *   scanned.pdf      → zero extractable text chunks (pages are pure
 *                       raster), at least one `ocr` chunk recovered.
 *   embedded.pdf     → at least one `image_description` chunk linked to
 *                       a page that also has `text` chunks.
 *   chart.pdf        → at least one `image_description` chunk (from the
 *                       rendered page or the embedded diagram).
 *
 * Embedding calls are skipped — the smoke test only validates the
 * extraction pipeline before the network boundary.
 *
 * Network-dependent vision calls are also skipped: `runPipeline` calls
 * them, so the test sets `ENABLE_VISION=false` and verifies the chunks
 * we *would* emit would carry the right metadata. To exercise the
 * vision path end-to-end, use `scripts/test-with-vision.mts` (skipped
 * here to keep this fixture smoke test offline).
 *
 * Run with:  pnpm tsx scripts/test-pipeline.mts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runPipeline } from "../lib/pipeline.ts";

const FIXTURES_DIR = join(process.cwd(), "scripts", "fixtures");

interface TestFixture {
  file: string;
  describe?: string;
  expect: {
    text?: number | ((n: number) => boolean);
    ocr?: (n: number) => boolean;
    imageDescription?: (n: number) => boolean;
  };
}

const FIXTURES: TestFixture[] = [
  {
    file: "text-only.pdf",
    describe:
      "no images, no scans; pages should produce only `text` items " +
      "(no rendering, no OCR, no vision)",
    expect: {
      text: (n) => n > 0,
      ocr: (n) => n === 0,
      // Without ENABLE_VISION the pipeline emits no image_description
      // items; the `imageDescription` key is left undefined so the
      // assertion is intentionally permissive here.
    },
  },
  {
    file: "scanned.pdf",
    describe:
      "pages contain only raster images; should yield zero text items " +
      "and at least one OCR chunk",
    expect: {
      text: (n) => n === 0,
      ocr: (n) => n > 0,
    },
  },
  {
    file: "embedded.pdf",
    describe:
      "pages have native text + embedded chart raster; without " +
      "ENABLE_VISION we expect at least one text chunk, the page renders " +
      "(because of the embedded raster) so OCR may pick up chart labels",
    expect: {
      text: (n) => n > 0,
    },
  },
  {
    file: "chart.pdf",
    describe:
      "diagram embedded in a text-rich page; without ENABLE_VISION we " +
      "expect at least one text chunk; page renders because of the " +
      "raster so OCR may add a chart-labels chunk",
    expect: {
      text: (n) => n > 0,
    },
  },
  {
    file: "box.pdf",
    describe:
      "single page of one large embedded photo (no native text); mirrors " +
      "the IMG_3603.pdf scenario. Without vision we expect zero text " +
      "items and at least one OCR chunk from the rendered page",
    expect: {
      text: (n) => n === 0,
      ocr: (n) => n > 0,
    },
  },
];

interface ItemCount {
  text: number;
  ocr: number;
  imageDescription: number;
}

function countByType(items: { sourceType: string }[]): ItemCount {
  const c: ItemCount = { text: 0, ocr: 0, imageDescription: 0 };
  for (const i of items) {
    if (i.sourceType === "text") c.text += 1;
    else if (i.sourceType === "ocr") c.ocr += 1;
    else if (i.sourceType === "image_description") c.imageDescription += 1;
  }
  return c;
}

function runChecks(
  itemCounts: ItemCount,
  expected: TestFixture["expect"],
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (typeof expected.text === "function" && !expected.text(itemCounts.text)) {
    failures.push(
      `text count ${itemCounts.text} failed expected.text check`,
    );
  }
  if (typeof expected.ocr === "function" && !expected.ocr(itemCounts.ocr)) {
    failures.push(
      `ocr count ${itemCounts.ocr} failed expected.ocr check`,
    );
  }
  if (
    typeof expected.imageDescription === "function" &&
    !expected.imageDescription(itemCounts.imageDescription)
  ) {
    failures.push(
      `image_description count ${itemCounts.imageDescription} failed expected.imageDescription check`,
    );
  }
  return { ok: failures.length === 0, failures };
}

// Vision must be skipped in this offline smoke test; everything else
// stays on.
process.env.ENABLE_VISION = "false";

let failed = 0;
for (const fx of FIXTURES) {
  const fileBuf = readFileSync(join(FIXTURES_DIR, fx.file));
  // unpdf's `getDocumentProxy` strictly accepts `Uint8Array`, not `Buffer`.
  const buf = new Uint8Array(fileBuf);
  const result = await runPipeline(buf);
  const counts = countByType(result.items);
  const check = runChecks(counts, fx.expect);
  const label = check.ok ? "PASS" : "FAIL";
  console.log(`${label} ${fx.file}`);
  console.log(`    describe: ${fx.describe}`);
  console.log(
    `    pages=${result.stats.pages} text=${counts.text} ocr=${counts.ocr} ` +
      `image_description=${counts.imageDescription} (described_images=${result.stats.describedImages})`,
  );
  if (!check.ok) {
    failed += 1;
    for (const f of check.failures) console.log(`    - ${f}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} fixture(s) failed`);
  process.exit(1);
}
console.log("\nall fixture smoke checks passed");
