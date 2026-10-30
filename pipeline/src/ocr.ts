// OCR engines. Primary: PaddleOCR PP-OCRv4 det+rec on onnxruntime-node (lib/paddle.ts), CPU only.
// Fallback: Tesseract.js (WASM LSTM) with local traineddata (no CDN download at runtime).
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import sharp from 'sharp';

export interface RawBox { text: string; x0: number; y0: number; x1: number; y1: number; conf: number }

import { ppocr } from './paddle';

// Serialise OCR calls: ONNX Runtime already uses all cores per call; parallel calls just thrash.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

/** Light preprocessing: grayscale + contrast normalisation. No hard binarisation (hurts PaddleOCR). */
export async function preprocess(png: Buffer, rotate = 0): Promise<Buffer> {
  let img = sharp(png).flatten({ background: '#ffffff' }).grayscale().normalise();
  if (rotate) img = img.rotate(rotate, { background: '#ffffff' });
  const g = await img.png().toBuffer();
  // Light background patterns (carrier watermarks like a repeated "KLN Container Line Ltd") get detected as text
  // by PP-OCR. If a large share of pixels sits in the light-grey band, push that band to white.
  const { data } = await sharp(g).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  let band = 0;
  for (let i = 0; i < data.length; i += 7) if (data[i] >= 185 && data[i] <= 238) band++;
  const share = band / (data.length / 7);
  if (share > 0.06) return sharp(g).linear(255 / 175, 0).png().toBuffer(); // >=175 -> white, text stays dark
  return g;
}

/** Share of light-grey pixels (exported for diagnostics). */
export async function lightBandShare(png: Buffer): Promise<number> {
  const { data } = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
  let band = 0;
  for (let i = 0; i < data.length; i += 7) if (data[i] >= 185 && data[i] <= 238) band++;
  return band / (data.length / 7);
}

export async function paddleOcr(png: Buffer): Promise<RawBox[]> {
  return serial(() => ppocr(png));
}

let tessWorker: Promise<any> | null = null;
export async function tesseractOcr(png: Buffer): Promise<RawBox[]> {
  return serial(async () => {
    if (!tessWorker) {
      tessWorker = (async () => {
        const { createWorker } = await import('tesseract.js');
        let langPath = path.join(process.cwd(), 'node_modules/@tesseract.js-data/eng/4.0.0_best_int');
        try { langPath = path.join(path.dirname(createRequire(import.meta.url).resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int'); } catch { /* cwd fallback */ }
        return createWorker('eng', 1, { langPath, gzip: true, cachePath: path.join(os.tmpdir(), 'tess-cache') });
      })();
    }
    const w = await tessWorker;
    const meta = await sharp(png).metadata();
    const r = await w.recognize(png, {}, { blocks: true });
    const out: RawBox[] = [];
    for (const b of r.data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
      out.push({
        text: l.text.trim(),
        x0: l.bbox.x0 / meta.width!, x1: l.bbox.x1 / meta.width!,
        y0: l.bbox.y0 / meta.height!, y1: l.bbox.y1 / meta.height!,
        conf: l.confidence / 100,
      });
    }
    return out.filter((b) => b.text);
  });
}

/** Detect a page scanned sideways: mostly 1-2 character boxes (vertical text lines get cut into characters). */
function looksRotated(boxes: RawBox[]): boolean {
  if (((boxes as RawBox[] & { verticalShare?: number }).verticalShare ?? 0) > 0.5) return true; // sideways page
  if (boxes.length < 15) return false;
  const tiny = boxes.filter((b) => b.text.replace(/\s/g, '').length <= 2).length;
  return tiny / boxes.length > 0.45;
}

export type OcrEngine = 'paddle' | 'tesseract';

export async function ocrPage(png: Buffer, engine: OcrEngine = 'paddle'): Promise<RawBox[]> {
  const run = engine === 'paddle' ? paddleOcr : tesseractOcr;
  const pre = await preprocess(png);
  let boxes = await run(pre);
  if (looksRotated(boxes)) {
    const candidates = await Promise.all([90, 270].map(async (deg) => ({ deg, boxes: await run(await preprocess(png, deg)) })));
    const score = (bs: RawBox[]) => bs.reduce((s, b) => s + b.conf * b.text.length, 0);
    const best = candidates.sort((a, b) => score(b.boxes) - score(a.boxes))[0];
    if (score(best.boxes) > score(boxes)) { boxes = best.boxes; (boxes as RawBox[] & { rotation?: number }).rotation = best.deg; }
  }
  const avg = boxes.length ? boxes.reduce((s, b) => s + b.conf, 0) / boxes.length : 0;
  if (engine === 'paddle' && (boxes.length < 3 || avg < 0.6)) {
    const t = await tesseractOcr(pre);
    if (t.length > boxes.length) return t;
  }
  return boxes;
}
