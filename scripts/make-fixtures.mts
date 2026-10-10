/**
 * Test fixtures for the image-aware PDF pipeline.
 *
 * Produces 4 PDFs in scripts/fixtures/:
 *
 *   1. text-only.pdf      — native text on every page; validates the
 *                           legacy path is unchanged.
 *   2. scanned.pdf        — rasterized pages only; pages have no
 *                           extractable text, exercises OCR.
 *   3. embedded.pdf       — native text + embedded JPEG images on each
 *                           page; exercises the per-image vision path.
 *   4. chart.pdf          — text + a simple SVG-style chart drawn with
 *                           pdfkit shapes; page is "thin" so it exercises
 *                           page-render + page-vision.
 *
 * Run with:  pnpm tsx scripts/make-fixtures.ts
 *
 * Outputs to scripts/fixtures/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// pdfkit's typings are loose; cast through `unknown` to a sane shape.
import PDFDocumentCtor from "pdfkit";
import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";

type PDFKit = InstanceType<typeof PDFDocumentCtor>;
const PDFDocument = PDFDocumentCtor as unknown as new (
  opts?: Record<string, unknown>,
) => PDFKit;

const OUT_DIR = join(process.cwd(), "scripts", "fixtures");
mkdirSync(OUT_DIR, { recursive: true });

function writePdf(
  name: string,
  draw: (doc: PDFKit) => void | Promise<void>,
): Promise<Uint8Array> {
  const { promise, resolve, reject } =
    Promise.withResolvers<Uint8Array>();
  const doc = new PDFDocument({ autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
  doc.on("error", (err: Error) => {
    console.error(`[make-fixtures] ${name} failed`, err);
    reject(err);
  });
  void Promise.resolve(draw(doc)).then(
    () => {
      doc.end();
    },
    (err: unknown) => {
      console.error(`[make-fixtures] ${name} draw failed`, err);
      reject(err as Error);
    },
  );
  return promise;
}

function addTextPage(doc: PDFKit, lines: string[]): void {
  doc.addPage({ size: "A4", margin: 48 });
  doc.fontSize(14);
  for (const line of lines) {
    doc.text(line);
    doc.moveDown(0.5);
  }
}

async function makeChartPng(label: string, value: number): Promise<Buffer> {
  const canvas = createCanvas(600, 360);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 600, 360);
  // Bar chart: 12 months on the X axis, value supplied.
  ctx.fillStyle = "#222";
  ctx.font = "20px sans-serif";
  ctx.fillText(label, 24, 32);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const max = Math.max(1, value * 1.4);
  ctx.strokeStyle = "#888";
  ctx.beginPath();
  ctx.moveTo(60, 320);
  ctx.lineTo(560, 320);
  ctx.stroke();
  months.forEach((m, i) => {
    const v = Math.max(20, Math.round(value * (0.6 + (i % 5) * 0.18)));
    const x = 60 + i * 42;
    const h = (v / max) * 200;
    ctx.fillStyle = "#3b82f6";
    ctx.fillRect(x, 320 - h, 30, h);
    ctx.fillStyle = "#444";
    ctx.font = "10px sans-serif";
    ctx.fillText(m, x + 4, 336);
    ctx.fillText(String(v), x + 4, 320 - h - 4);
  });
  return canvas.toBuffer("image/png");
}

async function makeDiagramPng(): Promise<Buffer> {
  const canvas = createCanvas(640, 360);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 640, 360);
  ctx.strokeStyle = "#222";
  ctx.lineWidth = 2;
  // 3 connected boxes for a simple workflow.
  const boxes = [
    { x: 50, y: 140, label: "Source" },
    { x: 240, y: 140, label: "Transform" },
    { x: 430, y: 140, label: "Output" },
  ];
  boxes.forEach((b) => {
    ctx.strokeRect(b.x, b.y, 140, 90);
    ctx.fillStyle = "#111";
    ctx.font = "20px sans-serif";
    ctx.fillText(b.label, b.x + 16, b.y + 50);
  });
  ctx.beginPath();
  ctx.moveTo(190, 185); ctx.lineTo(240, 185); ctx.stroke();
  ctx.moveTo(380, 185); ctx.lineTo(430, 185); ctx.stroke();
  ctx.fillStyle = "#444";
  ctx.font = "14px sans-serif";
  ctx.fillText("Step 1: ingest PDF", 160, 170);
  ctx.fillText("Step 2: index content", 360, 170);
  return canvas.toBuffer("image/png");
}

async function imageBufferToJpeg(png: Buffer): Promise<Buffer> {
  return sharp(png).jpeg({ quality: 80 }).toBuffer();
}

async function generateTextOnly(): Promise<Uint8Array> {
  return writePdf("text-only", async (doc) => {
    addTextPage(doc, [
      "Chapter 1 — Overview",
      "This PDF contains only extractable text. No images, no scans.",
      "It exists to confirm that the legacy text-only path still works",
      "after the image-pipeline changes.",
    ]);
    addTextPage(doc, [
      "Chapter 2 — Procedure",
      "Each page feeds straight into the paragraph chunker.",
      "There are no charts, diagrams, or photos.",
      "Citations should land exclusively on 'text' source chunks.",
    ]);
  });
}

async function generateScanned(): Promise<Uint8Array> {
  return writePdf("scanned", async (doc) => {
    // Build two pages where the visible content is a rasterized image
    // that just contains short printed text. No native text is added.
    const pageA = await sharp({
      // a tiny pure-raster "page" -> embedded image so unpdf sees the
      // whole content as one big picture.
      create: {
        width: 900,
        height: 1273,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="900" height="1273" xmlns="http://www.w3.org/2000/svg">` +
              `<rect width="100%" height="100%" fill="white"/>` +
              `<text x="48" y="120" font-size="48" font-family="sans-serif" fill="black">SCANNED RECEIPT</text>` +
              `<text x="48" y="200" font-size="32" font-family="sans-serif" fill="black">Item: Coffee</text>` +
              `<text x="48" y="260" font-size="32" font-family="sans-serif" fill="black">Item: Bagel</text>` +
              `<text x="48" y="600" font-size="36" font-family="sans-serif" fill="black">TOTAL: 12.50 USD</text>` +
              `</svg>`,
          ),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();
    const pageB = await sharp({
      create: {
        width: 900, height: 1273, channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="900" height="1273" xmlns="http://www.w3.org/2000/svg">` +
              `<rect width="100%" height="100%" fill="white"/>` +
              `<text x="48" y="120" font-size="44" font-family="sans-serif" fill="black">SCANNED INVOICE</text>` +
              `<text x="48" y="200" font-size="32" font-family="sans-serif" fill="black">Vendor: Acme Corp</text>` +
              `<text x="48" y="260" font-size="32" font-family="sans-serif" fill="black">Number: INV-42</text>` +
              `<text x="48" y="600" font-size="36" font-family="sans-serif" fill="black">AMOUNT DUE: 250.00 USD</text>` +
              `</svg>`,
          ),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();
    const imgA = await sharp(pageA).jpeg({ quality: 80 }).toBuffer();
    const imgB = await sharp(pageB).jpeg({ quality: 80 }).toBuffer();
    doc.addPage({ size: "A4", margin: 0 });
    // Fill the whole page with the raster image, but place it big enough
    // that pdfjs has no choice but to render it.
    doc.image(imgA, 0, 0, { width: 595, height: 842 });
    doc.addPage({ size: "A4", margin: 0 });
    doc.image(imgB, 0, 0, { width: 595, height: 842 });
  });
}

async function generateEmbedded(): Promise<Uint8Array> {
  return writePdf("embedded", async (doc) => {
    const chart = await makeChartPng("Quarterly Revenue (USD)", 1200);
    const chartJpg = await imageBufferToJpeg(chart);
    addTextPage(doc, [
      "Quarterly Performance Report",
      "Below is a chart showing revenue across the past 12 months.",
    ]);
    doc.image(chartJpg, 72, 220, { width: 480, height: 280 });
    doc.text("Note: peak in Q3 reflects product launch.", 72, 520);
  });
}

async function generateChart(): Promise<Uint8Array> {
  return writePdf("chart", async (doc) => {
    const diag = await makeDiagramPng();
    const diagJpg = await imageBufferToJpeg(diag);
    addTextPage(doc, [
      "Indexing Pipeline Diagram",
      "The diagram below shows how a PDF is parsed and indexed.",
    ]);
    doc.image(diagJpg, 72, 220, { width: 480, height: 270 });
  });
}

/**
 * Single-page photo of a product box (like the IMG_3603.pdf scenario):
 * no native text, one large embedded JPEG. Pipeline must reach vision
 * via the rendered-page path AND the embedded-image path.
 */
async function makeBoxPng(): Promise<Buffer> {
  const canvas = createCanvas(900, 1200);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, 900, 1200);
  // Brand strip.
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(0, 0, 900, 120);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 36px sans-serif";
  ctx.fillText("BOMBAY SHAVER", 40, 80);
  // Box outline.
  ctx.strokeStyle = "#222";
  ctx.lineWidth = 4;
  ctx.strokeRect(80, 200, 740, 700);
  ctx.fillStyle = "#222";
  ctx.font = "bold 48px sans-serif";
  ctx.fillText("Power Styler", 110, 300);
  ctx.font = "bold 36px sans-serif";
  ctx.fillText("Beard Trimmer", 110, 360);
  // Contents label + list (the bits the regression test looks for).
  ctx.fillStyle = "#000";
  ctx.font = "bold 28px sans-serif";
  ctx.fillText("What's inside:", 110, 480);
  ctx.font = "24px sans-serif";
  ctx.fillText("- Power Styler Beard Trimmer", 120, 540);
  ctx.fillText("- Type-C charging cable", 120, 590);
  ctx.fillText("- Cleaning brush", 120, 640);
  ctx.fillText("- 2 beard combs", 120, 690);
  // Footer.
  ctx.fillStyle = "#666";
  ctx.font = "18px sans-serif";
  ctx.fillText("Model BS-104 · Made in India", 110, 830);
  return canvas.toBuffer("image/png");
}

async function generateBox(): Promise<Uint8Array> {
  return writePdf("box", async (doc) => {
    const box = await makeBoxPng();
    const boxJpg = await imageBufferToJpeg(box);
    doc.addPage({ size: "A4", margin: 0 });
    // Fill the whole page with the JPEG so pdfjs must render it as
    // an embedded raster — same shape as IMG_3603.pdf.
    doc.image(boxJpg, 0, 0, { width: 595, height: 842 });
  });
}

async function main(): Promise<void> {
  const fixtures: Record<string, Uint8Array> = {};
  fixtures["text-only.pdf"] = await generateTextOnly();
  fixtures["scanned.pdf"] = await generateScanned();
  fixtures["embedded.pdf"] = await generateEmbedded();
  fixtures["chart.pdf"] = await generateChart();
  fixtures["box.pdf"] = await generateBox();
  for (const [name, bytes] of Object.entries(fixtures)) {
    const path = join(OUT_DIR, name);
    writeFileSync(path, Buffer.from(bytes));
    console.log(`wrote ${path} (${bytes.byteLength} bytes)`);
  }
}

await main();
