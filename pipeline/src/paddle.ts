// Minimal PP-OCR engine on onnxruntime-node (CPU). PP-OCRv4 mobile ONNX models (models/ppocr-v4), with the
// official PaddleOCR pre/post-processing: det thresh 0.3 / box_thresh 0.6 / unclip 1.5, ImageNet-normalised det input,
// (x/255-0.5)/0.5 rec input, batched recognition. Faster and gives one box per text block instead of whole form rows.
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { RawBox } from './ocr';

const require = createRequire(import.meta.url);

type Ort = typeof import('onnxruntime-node');
interface Engine { ort: Ort; det: any; rec: any; dict: string[] }

let enginePromise: Promise<Engine> | null = null;

function modelPaths() {
  // OCR_MODEL_DIR > ./models/ppocr-v4 of the running app > models/ shipped next to this package (freight-extract)
  let dir = process.env.OCR_MODEL_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'models', 'ppocr-v4');
  if (!process.env.OCR_MODEL_DIR && !existsSync(path.join(dir, 'det.onnx'))) {
    try { const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models', 'ppocr-v4'); if (existsSync(path.join(pkg, 'det.onnx'))) dir = pkg; } catch { /* keep cwd path */ }
  }
  return { det: path.join(dir, 'det.onnx'), rec: path.join(dir, 'rec.onnx'), dict: path.join(dir, 'dict.txt') };
}

export function getEngine(): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const ort: Ort = require('onnxruntime-node');
      const p = modelPaths();
      const threads = Number(process.env.OCR_THREADS ?? 0) || undefined; // default: ORT picks #cores
      const opts: Record<string, unknown> = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' };
      if (threads) opts.intraOpNumThreads = threads;
      const [det, rec] = await Promise.all([ort.InferenceSession.create(p.det, opts), ort.InferenceSession.create(p.rec, opts)]);
      const dict = readFileSync(/* turbopackIgnore: true */ p.dict, 'utf8').split(/\r?\n/).filter((l, i, a) => !(i === a.length - 1 && l === ''));
      dict.push(' '); // use_space_char
      return { ort, det, rec, dict };
    })();
  }
  return enginePromise;
}

const DET_LIMIT = Number(process.env.OCR_DET_LIMIT ?? 1600); // max side for detection
const THRESH = 0.3, BOX_THRESH = 0.6, UNCLIP = 1.6;
const REC_H = 48, REC_BATCH = 8, REC_MAX_W = 2800;

/** Detect + recognise text boxes on a page image. Returns boxes normalised to 0..1. */
export async function ppocr(png: Buffer, deskewed = false): Promise<RawBox[]> {
  const { ort, det, rec, dict } = await getEngine();
  const base = sharp(png).flatten({ background: '#ffffff' }).removeAlpha();
  const meta = await base.metadata();
  const W0 = meta.width!, H0 = meta.height!;
  const gray = await sharp(png).flatten({ background: '#ffffff' }).removeAlpha().toColourspace('b-w').raw().toBuffer(); // for crops
  if (gray.length !== W0 * H0) throw new Error('unexpected gray buffer size');

  // ---- detection ----
  const ratio = Math.min(1, DET_LIMIT / Math.max(W0, H0));
  const dw = Math.max(32, Math.round((W0 * ratio) / 32) * 32), dh = Math.max(32, Math.round((H0 * ratio) / 32) * 32);
  const rgb = await sharp(png).flatten({ background: '#ffffff' }).removeAlpha().toColourspace('srgb').resize(dw, dh, { fit: 'fill' }).raw().toBuffer();
  if (rgb.length !== dw * dh * 3) throw new Error(`unexpected channel count ${rgb.length / (dw * dh)}`);
  const n = dw * dh;
  const input = new Float32Array(3 * n);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0; i < n; i++) {
    // PaddleOCR feeds BGR; the normalisation constants are applied in that channel order
    const b = rgb[i * 3 + 2], g = rgb[i * 3 + 1], r = rgb[i * 3];
    input[i] = (b / 255 - mean[0]) / std[0];
    input[n + i] = (g / 255 - mean[1]) / std[1];
    input[2 * n + i] = (r / 255 - mean[2]) / std[2];
  }
  const dout = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, dh, dw]) });
  const prob = dout[det.outputNames[0]].data as Float32Array;

  // connected components on the binary map (4-neighbour), axis-aligned boxes
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = prob[i] > THRESH ? 1 : 0;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const angles: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!mask[s] || seen[s]) continue;
    let sp = 0; stack[sp++] = s; seen[s] = 1;
    let x0 = dw, y0 = dh, x1 = 0, y1 = 0, sum = 0, cnt = 0, sx_ = 0, sy_ = 0, sxx = 0, syy = 0, sxy = 0;
    while (sp) {
      const p = stack[--sp];
      const x = p % dw, y = (p - x) / dw;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      sum += prob[p]; cnt++; sx_ += x; sy_ += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < dw - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - dw] && !seen[p - dw]) { seen[p - dw] = 1; stack[sp++] = p - dw; }
      if (y < dh - 1 && mask[p + dw] && !seen[p + dw]) { seen[p + dw] = 1; stack[sp++] = p + dw; }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (Math.min(w, h) < 3 || sum / cnt < BOX_THRESH) continue;
    if (w > 60 && cnt > 200) { // orientation of long text lines (PCA) -> page skew estimate
      const mx = sx_ / cnt, my = sy_ / cnt;
      const cxx = sxx / cnt - mx * mx, cyy = syy / cnt - my * my, cxy = sxy / cnt - mx * my;
      const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      if (cxx > 16 * cyy) angles.push(ang);
    }
    const d = (w * h * UNCLIP) / (2 * (w + h)); // polygon unclip distance for a rectangle
    boxes.push({ x0: Math.max(0, x0 - d), y0: Math.max(0, y0 - d), x1: Math.min(dw - 1, x1 + d), y1: Math.min(dh - 1, y1 + d) });
  }
  if (process.env.OCR_DEBUG) { let m = 0; for (let i = 0; i < n; i++) m += mask[i]; console.error('det', { dw, dh, maskFrac: m / n, boxes: boxes.length }); }
  if (!boxes.length) return [];
  // Deskew: rotate the page by the median line angle and run again (once). Skew squashes long lines in recognition.
  if (!deskewed && angles.length >= 5) {
    const sorted = [...angles].sort((a, z) => a - z);
    const med = (sorted[Math.floor(sorted.length / 2)] * 180) / Math.PI;
    if (Math.abs(med) > 0.2 && Math.abs(med) < 10) {
      const rot = await sharp(png).flatten({ background: '#ffffff' }).rotate(-med, { background: '#ffffff' }).png().toBuffer();
      const meta2 = await sharp(rot).metadata();
      // crop back to the original size around the centre so normalised coordinates stay comparable
      const left = Math.max(0, Math.round((meta2.width! - W0) / 2)), top = Math.max(0, Math.round((meta2.height! - H0) / 2));
      const fixed = await sharp(rot).extract({ left, top, width: Math.min(W0, meta2.width! - left), height: Math.min(H0, meta2.height! - top) }).png().toBuffer();
      return ppocr(fixed, true);
    }
  }

  // ---- recognition (batched, sorted by aspect ratio like PaddleOCR) ----
  const sx = W0 / dw, sy = H0 / dh;
  const crops = await Promise.all(boxes.map(async (b) => {
    const left = Math.max(0, Math.floor(b.x0 * sx)), top = Math.max(0, Math.floor(b.y0 * sy));
    const width = Math.max(1, Math.min(W0 - left, Math.ceil((b.x1 - b.x0) * sx))), height = Math.max(1, Math.min(H0 - top, Math.ceil((b.y1 - b.y0) * sy)));
    const tw = Math.min(REC_MAX_W, Math.max(8, Math.round((width * REC_H) / height)));
    const data = await sharp(gray, { raw: { width: W0, height: H0, channels: 1 } }).extract({ left, top, width, height }).resize(tw, REC_H, { fit: 'fill' }).extractChannel(0).raw().toBuffer();
    return { b, left, top, width, height, tw, data, vertical: height > width * 1.5 };
  }));
  const order = crops.map((c, i) => i).filter((i) => !crops[i].vertical).sort((a, z) => crops[a].tw - crops[z].tw);
  const out: RawBox[] = [];
  for (let k = 0; k < order.length; k += REC_BATCH) {
    const idx = order.slice(k, k + REC_BATCH);
    const bw = Math.max(320, ...idx.map((i) => crops[i].tw));
    const t = new Float32Array(idx.length * 3 * REC_H * bw); // zero padding (= mid-gray after normalisation)
    idx.forEach((ci, bi) => {
      const c = crops[ci];
      const plane = REC_H * bw;
      for (let y = 0; y < REC_H; y++) for (let x = 0; x < c.tw; x++) {
        const v = (c.data[y * c.tw + x] / 255 - 0.5) / 0.5;
        const o = bi * 3 * plane + y * bw + x;
        t[o] = v; t[o + plane] = v; t[o + 2 * plane] = v;
      }
    });
    const ro = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', t, [idx.length, 3, REC_H, bw]) });
    const o = ro[rec.outputNames[0]];
    const [N, T, C] = o.dims as number[];
    const data = o.data as Float32Array;
    for (let bi = 0; bi < N; bi++) {
      let text = '', confSum = 0, confN = 0, prev = -1;
      const c = crops[idx[bi]];
      const maxT = Math.min(T, Math.ceil((c.tw / bw) * T) + 2); // ignore padded timesteps
      for (let ti = 0; ti < maxT; ti++) {
        let best = 0, bp = -1;
        const off = (bi * T + ti) * C;
        for (let ci = 0; ci < C; ci++) { const v = data[off + ci]; if (v > bp) { bp = v; best = ci; } }
        if (best !== 0 && best !== prev) { text += dict[best - 1] ?? ''; confSum += bp; confN++; }
        prev = best;
      }
      const conf = confN ? confSum / confN : 0;
      if (!text.trim() || conf < 0.5) continue;
      out.push({ text: text.trim(), x0: c.left / W0, y0: c.top / H0, x1: (c.left + c.width) / W0, y1: (c.top + c.height) / H0, conf });
    }
  }
  // share of tall (vertical) text boxes: a page scanned sideways has mostly vertical lines; ocr.ts retries rotated
  (out as RawBox[] & { verticalShare?: number }).verticalShare = crops.filter((c) => Math.max(c.width, c.height) > 40 && c.vertical).length / Math.max(1, crops.filter((c) => Math.max(c.width, c.height) > 40).length);
  return out;
}
