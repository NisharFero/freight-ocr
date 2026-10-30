// Stage 1-4: read PDF text layer, QA it, render + OCR only the pages that need it.
import { getDocumentProxy, renderPageAsImage, getResolvedPDFJS } from 'unpdf';
import sharp from 'sharp';
import type { IngestResult, PageData } from './types';
import { buildLines } from './layout';
import { loadDict, recoverSpaces } from './segment';
import { ocrPage, type OcrEngine, type RawBox } from './ocr';

async function wordRatio(s: string): Promise<number> {
  const dict = await loadDict();
  const toks = recoverSpaces(s, dict).split(/[^A-Za-z]+/).filter((w) => w.length >= 3);
  if (toks.length < 5) return toks.length ? 0.5 : 0;
  return toks.filter((w) => dict.has(w.toLowerCase())).length / toks.length;
}

const OCR_SCALE = 2.5; // ~180 DPI: good accuracy/speed balance for PP-OCR on A4
const MAX_PAGES = 20;

function garbageRatio(s: string): number {
  const t = s.replace(/\s/g, '');
  if (!t.length) return 1;
  const bad = t.replace(/[\x21-\x7E -ſ°±€£§–—‘’“”•·]/g, '').length;
  return bad / t.length;
}

type Mat = [number, number, number, number, number, number];
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Largest painted image area as a fraction of the page (scanned page = ~1.0). */
async function largestImageFraction(page: any, W: number, H: number): Promise<number> {
  const pdfjs: any = await getResolvedPDFJS();
  const OPS = pdfjs.OPS;
  const ops = await page.getOperatorList();
  let ctm: Mat = [1, 0, 0, 1, 0, 0];
  const stack: Mat[] = [];
  let best = 0;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, ops.argsArray[i] as Mat);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); const m = ops.argsArray[i]?.[0]; if (m && m.length === 6) ctm = mul(ctm, m as Mat); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
      best = Math.max(best, Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) / (W * H));
    }
  }
  return best;
}

export interface IngestOptions { engine?: OcrEngine; forceOcr?: boolean }

export async function ingest(fileName: string, data: Uint8Array, opts: IngestOptions = {}): Promise<IngestResult> {
  const t0 = Date.now();
  const isPdf = data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46; // %PDF
  if (!isPdf) return ingestImage(fileName, data, opts, t0);

  const pdf = await getDocumentProxy(data.slice());
  const pages: PageData[] = [];
  const thumbs: { page: number; thumb: Buffer; fine: Buffer }[] = [];
  const n = Math.min(pdf.numPages, MAX_PAGES);
  for (let p = 1; p <= n; p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const W = vp.width, H = vp.height;
    const tc = await page.getTextContent();
    const boxes: RawBox[] = [];
    for (const it of tc.items as any[]) {
      if (!it.str || !it.str.trim()) continue;
      const [a, b, c, d, e, f] = pdfjsTransform(vp.transform, it.transform);
      if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue; // skip rotated text runs
      const h = Math.abs(d) || it.height;
      boxes.push({ text: it.str, x0: e / W, x1: (e + it.width * (vp.scale)) / W, y0: (f - h) / H, y1: f / H, conf: 1 });
    }
    const allText = boxes.map((b) => b.text).join(' ');
    const chars = allText.replace(/\s/g, '').length;
    const gr = garbageRatio(allText);
    const imgFrac = await largestImageFraction(page, W, H);
    const hasFullPageImage = imgFrac > 0.6;

    let reason = 'text-layer ok';
    let useOcr = !!opts.forceOcr;
    if (opts.forceOcr) reason = 'forced';
    else if (chars < 150) { useOcr = true; reason = `no/sparse text layer (${chars} chars)`; }
    else if (gr > 0.08) { useOcr = true; reason = `garbled text layer (${(gr * 100).toFixed(0)}% bad chars)`; }
    else if (hasFullPageImage && chars < 300) { useOcr = true; reason = `scanned page, sparse text layer (${chars} chars) -> OCR`; }
    else if (hasFullPageImage) {
      const wr = await wordRatio(allText);
      const toks = allText.split(/\s+/).filter(Boolean);
      const weird = toks.filter((w) => /[A-Za-z]/.test(w) && (/[\\|]/.test(w) || /[a-z][A-Z]|[A-Z]\d[A-Z]|\d[A-Z]\d/.test(w))).length / Math.max(toks.length, 1);
      // letter-spaced junk from a cheap scanner OCR layer: "C o u n t r yo f o r i g i n"
      const singles = toks.filter((w) => /^[A-Za-z]$/.test(w) && !/^[aAI]$/.test(w)).length / Math.max(toks.length, 1);
      if (wr < 0.6 || (wr < 0.8 && weird > 0.02) || singles > 0.15) { useOcr = true; reason = `scanned page, low-quality OCR text layer (word ratio ${wr.toFixed(2)}) -> re-OCR`; }
      else reason = `image-backed page, text layer accepted (word ratio ${wr.toFixed(2)})`;
    }

    if (!useOcr) {
      pages.push({ page: p, width: W, height: H, source: 'text-layer', qa: { chars, garbageRatio: gr, hasFullPageImage, reason }, lines: buildLines(boxes, p, W / H) });
      continue;
    }
    const tO = Date.now();
    const png = Buffer.from(await renderPageAsImage(pdf as any, p, { canvasImport: () => import('@napi-rs/canvas'), scale: OCR_SCALE }));
    // Skip OCR for near-identical copies (AWB "Original 1/2/3", repeated courier labels)
    // Coarse thumbnail first, then a 400x520 check: pages of one multi-page table share a template and look
    // the same at 48x64 (CTT p2 vs p3: 1.7) but differ in ~4% of pixels; true copies differ in <0.2%.
    const thumb = await sharp(png).resize(48, 64, { fit: 'fill' }).grayscale().raw().toBuffer();
    const fine = await sharp(png).resize(400, 520, { fit: 'fill' }).grayscale().raw().toBuffer();
    const dup = thumbs.find((t) => meanAbsDiff(t.thumb, thumb) < 2.5 && changedFraction(t.fine, fine) < 0.004);
    if (dup) {
      const src = pages.find((x) => x.page === dup.page)!;
      pages.push({ ...src, page: p, lines: src.lines.map((l) => ({ ...l, page: p })), qa: { chars, garbageRatio: gr, hasFullPageImage, reason: `duplicate of page ${dup.page} - OCR skipped` }, ocrMs: Date.now() - tO });
      continue;
    }
    thumbs.push({ page: p, thumb, fine });
    let ob = await ocrPage(png, opts.engine);
    const fl = await flipIfUpsideDown(png, ob, opts.engine);
    if (fl !== ob) { ob = fl; reason += ' (rotated 180°)'; }
    pages.push({ page: p, width: W, height: H, source: 'ocr', qa: { chars, garbageRatio: gr, hasFullPageImage, reason }, lines: buildLines(ob, p, aspectOf(ob, W / H), 0.5), ocrMs: Date.now() - tO });
    if ((ob as any).rotation) pages[pages.length - 1].qa.reason += ` (rotated ${(ob as any).rotation}°)`;
    // Courier labels / commercial-invoice copies attached to a label PDF: one page is enough.
    if (p === 1 && n > 2 && /FEDEX|\bTRK\s*#|\bDHL\b|\bUPS\b|ARAMEX/i.test(ob.map((b) => b.text).join(' '))) {
      pages[0].qa.reason += `; courier label - remaining ${n - 1} page(s) skipped`;
      break;
    }
  }
  return { fileName, pages, ms: Date.now() - t0 };
}

/** Boxes from a page OCR'd after a 90/270° turn are normalised to the turned image: swap the aspect. */
function aspectOf(ob: RawBox[], aspect: number): number {
  const r = (ob as RawBox[] & { rotation?: number }).rotation;
  return r === 90 || r === 270 ? 1 / aspect : aspect;
}

/**
 * Upside-down page: the recogniser drops most crops (confidence < 0.5) and what it keeps is not words.
 * Checked only when the first pass looks weak, so normal pages pay nothing.
 */
async function flipIfUpsideDown(png: Buffer, ob: RawBox[], engine: IngestOptions['engine']): Promise<RawBox[]> {
  if ((ob as RawBox[] & { rotation?: number }).rotation) return ob; // already turned 90/270
  const txt = ob.map((b) => b.text).join(' ');
  const avg = ob.length ? ob.reduce((s, b) => s + b.conf, 0) / ob.length : 0;
  const weak = txt.length < 150 || avg < 0.85 || (txt.length > 60 && (await wordRatio(txt)) < 0.3);
  if (!weak) return ob;
  const flipped = await ocrPage(await sharp(png).rotate(180).png().toBuffer(), engine);
  const score = (bs: RawBox[]) => bs.reduce((s, b) => s + b.conf * b.text.length, 0);
  const ft = flipped.map((b) => b.text).join(' ');
  if (score(flipped) > 1.5 * score(ob) && (await wordRatio(ft)) >= (await wordRatio(txt))) return flipped;
  return ob;
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** Share of pixels that changed clearly (grey level difference > 48). */
function changedFraction(a: Buffer, b: Buffer): number {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 48) c++;
  return c / a.length;
}

function pdfjsTransform(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

async function ingestImage(fileName: string, data: Uint8Array, opts: IngestOptions, t0: number): Promise<IngestResult> {
  const png = await sharp(Buffer.from(data)).rotate().png().toBuffer(); // .rotate() applies EXIF orientation
  const meta = await sharp(png).metadata();
  const tO = Date.now();
  let ob = await ocrPage(png, opts.engine);
  ob = await flipIfUpsideDown(png, ob, opts.engine);
  return {
    fileName,
    pages: [{ page: 1, width: meta.width!, height: meta.height!, source: 'ocr', qa: { chars: 0, garbageRatio: 0, hasFullPageImage: true, reason: 'image upload' }, lines: buildLines(ob, 1, aspectOf(ob, meta.width! / meta.height!), 0.5), ocrMs: Date.now() - tO }],
    ms: Date.now() - t0,
  };
}
