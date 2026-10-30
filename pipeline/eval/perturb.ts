// Perturbation suite: re-creates each client doc the way production may send it (scanned PDF at low dpi, rotated,
// skewed, phone photo, duplicated pages, several docs merged into one PDF), runs the pipeline and writes
// out/perturb/<folder>__<file>@<variant>.json for eval/metrics.ts. Gold = the same labels as the original doc.
//   tsx eval/perturb.ts <samples-root> [variant,variant...] [--only <substring>]
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { getDocumentProxy, renderPageAsImage } from 'unpdf';
import { processFile } from '../src/pipeline';

type Variant = { dpi: number; fx: (img: Sharp, i: number) => Sharp; asImage?: boolean; note: string };

const lightGradient = (w: number, h: number) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><radialGradient id="g" cx="35%" cy="30%" r="90%">` +
  `<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#9a9a9a"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`);

export const VARIANTS: Record<string, Variant> = {
  scan150: { dpi: 150, note: 'office scan: 1.5° skew, blur, JPEG q55', fx: (s, i) => s.rotate(i % 2 ? 1.5 : -1.5, { background: '#fff' }).blur(0.6).jpeg({ quality: 55 }) },
  dpi100: { dpi: 100, note: 'low-resolution fax-like scan, JPEG q70', fx: (s) => s.jpeg({ quality: 70 }) },
  rot90: { dpi: 200, note: 'page scanned sideways (90° CW)', fx: (s) => s.rotate(90).jpeg({ quality: 80 }) },
  rot180: { dpi: 200, note: 'page scanned upside down', fx: (s) => s.rotate(180).jpeg({ quality: 80 }) },
  rot270: { dpi: 200, note: 'page scanned sideways (90° CCW)', fx: (s) => s.rotate(270).jpeg({ quality: 80 }) },
  skew3: { dpi: 200, note: '3° skew on a grey, slightly dark scan', fx: (s) => s.rotate(3, { background: '#ddd' }).linear(0.85, 10).jpeg({ quality: 70 }) },
  photo: { dpi: 170, note: 'phone photo: shear, uneven light, blur, JPEG q60', fx: (s) => s.affine([[1, 0.03], [0.015, 1]], { background: '#bbb' }).blur(0.9).jpeg({ quality: 60 }) },
  dup: { dpi: 0, note: 'original PDF with every page duplicated (copies / resend)', fx: (s) => s },
};

async function renderPages(file: string, data: Uint8Array, dpi: number): Promise<Buffer[]> {
  if (!/\.pdf$/i.test(file)) {
    const meta = await sharp(Buffer.from(data)).metadata();
    const scale = dpi / 200; // client images are ~200 dpi phone/scanner output
    return [await sharp(Buffer.from(data)).resize(Math.round((meta.width ?? 1000) * scale)).flatten({ background: '#fff' }).png().toBuffer()];
  }
  const pdf = await getDocumentProxy(data.slice());
  const out: Buffer[] = [];
  for (let p = 1; p <= Math.min(pdf.numPages, 8); p++) {
    out.push(Buffer.from(await renderPageAsImage(pdf as any, p, { canvasImport: () => import('@napi-rs/canvas'), scale: dpi / 72 })));
  }
  return out;
}

async function imagesToPdf(imgs: Buffer[], dpi: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const jpg of imgs) {
    const im = await doc.embedJpg(jpg);
    const page = doc.addPage([(im.width * 72) / dpi, (im.height * 72) / dpi]);
    page.drawImage(im, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  return doc.save();
}

export async function makeVariant(name: string, file: string, data: Uint8Array): Promise<{ file: string; data: Uint8Array }> {
  const v = VARIANTS[name];
  if (name === 'dup') {
    if (!/\.pdf$/i.test(file)) {
      const png = await sharp(Buffer.from(data)).jpeg({ quality: 90 }).toBuffer();
      return { file: file.replace(/\.\w+$/, '.pdf'), data: await imagesToPdf([png, png], 200) };
    }
    try {
      const src = await PDFDocument.load(data, { ignoreEncryption: true });
      const doc = await PDFDocument.create();
      for (const i of src.getPageIndices()) for (const pg of await doc.copyPages(src, [i, i])) doc.addPage(pg);
      return { file, data: await doc.save() };
    } catch { // PDF pdf-lib cannot parse (broken xref): duplicate rendered pages instead
      const imgs = await Promise.all((await renderPages(file, data, 200)).map((p) => sharp(p).flatten({ background: '#fff' }).jpeg({ quality: 90 }).toBuffer()));
      return { file, data: await imagesToPdf(imgs.flatMap((i) => [i, i]), 200) };
    }
  }
  const pages = await renderPages(file, data, v.dpi);
  const imgs = await Promise.all(pages.map((p, i) => v.fx(sharp(p).flatten({ background: '#fff' }), i).toBuffer()));
  if (name === 'photo') {
    for (let i = 0; i < imgs.length; i++) {
      const m = await sharp(imgs[i]).metadata();
      imgs[i] = await sharp(imgs[i]).composite([{ input: lightGradient(m.width!, m.height!), blend: 'multiply' }]).jpeg({ quality: 60 }).toBuffer();
    }
  }
  if (imgs.length === 1 && (name === 'photo' || name === 'rot90')) return { file: file.replace(/\.\w+$/, '.jpg'), data: new Uint8Array(imgs[0]) };
  return { file: file.replace(/\.\w+$/, '.pdf'), data: await imagesToPdf(imgs, v.dpi) };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('perturb.ts')) {
  const root = process.argv[2] ?? 'samples';
  const names = (process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3].split(',') : Object.keys(VARIANTS));
  const oi = process.argv.indexOf('--only');
  const only = oi > 0 ? process.argv[oi + 1] : '';
  const outDir = process.env.OUT ?? 'out/perturb';
  await mkdir(outDir, { recursive: true });
  const gold = JSON.parse(await readFile('eval/gold.json', 'utf8'));
  const keys = Object.keys(gold).filter((k) => !k.startsWith('_') && (!only || new RegExp(only).test(k)));
  for (const name of names) {
    const t0 = Date.now();
    if (name === 'merged') { await merged(root, outDir, keys); continue; }
    if (!VARIANTS[name]) { console.log(`unknown variant ${name}`); continue; }
    for (const key of keys) {
      const [d, f] = key.split('/');
      const outFile = path.join(outDir, `${d}__${f}@${name}.json`);
      if (process.env.SKIP_EXISTING === '1') { try { await readFile(outFile); continue; } catch { /* not done yet */ } }
      const src = new Uint8Array(await readFile(path.join(root, d, f)));
      const v = await makeVariant(name, f, src);
      const t = Date.now();
      const [r] = await processFile(v.file, v.data);
      await writeFile(outFile, JSON.stringify({ ...r, ms: Date.now() - t }, null, 1));
      console.log(`${name.padEnd(8)} ${String(Date.now() - t).padStart(6)}ms ${r.docType.padEnd(20)} review=${r.needsReview} ${f}`);
    }
    console.log(`== ${name} done in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  console.log(`maxRSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
  process.exit(0); // ONNX / worker handles keep the event loop alive
}

async function merged(root: string, outDir: string, keys: string[]) {
  const byShip = new Map<string, string[]>();
  for (const k of keys) { const [d, f] = k.split('/'); byShip.set(d, [...(byShip.get(d) ?? []), f]); }
  const manifest: Record<string, { pages: number[]; key: string }[]> = {};
  for (const [d, fs] of byShip) {
    const pdfs = fs.filter((f) => /\.pdf$/i.test(f) && !/FedEx/i.test(f));
    if (pdfs.length < 2) continue;
    const doc = await PDFDocument.create();
    manifest[d] = [];
    for (const f of pdfs) {
      const start = doc.getPageCount();
      try {
        const src = await PDFDocument.load(new Uint8Array(await readFile(path.join(root, d, f))), { ignoreEncryption: true });
        for (const pg of await doc.copyPages(src, src.getPageIndices())) doc.addPage(pg);
      } catch (e) { console.log(`merged   skip ${f}: pdf-lib cannot copy it (${(e as Error).message.slice(0, 60)})`); continue; }
      manifest[d].push({ key: `${d}/${f}`, pages: [start + 1, doc.getPageCount()] });
    }
    const t = Date.now();
    const results = await processFile(`${d} merged.pdf`, await doc.save());
    // Map each split result to the original doc whose page range contains its first page.
    for (const r of results) {
      const first = r.pageRange?.[0] ?? 1;
      const m = manifest[d].find((x) => first >= x.pages[0] && first <= x.pages[1]);
      if (!m) continue;
      const [, f] = m.key.split('/');
      await writeFile(path.join(outDir, `${d}__${f}@merged.json`), JSON.stringify({ ...r, ms: Date.now() - t }, null, 1));
    }
    // a doc the splitter failed to separate gets an empty result, so its fields count as misses
    for (const m of manifest[d]) {
      const [, f] = m.key.split('/');
      if (!results.some((r) => { const first = r.pageRange?.[0] ?? 1; return first >= m.pages[0] && first <= m.pages[1]; }))
        await writeFile(path.join(outDir, `${d}__${f}@merged.json`), JSON.stringify({ fileName: f, docType: 'NOT_SPLIT', fields: {}, needsReview: true, reviewReasons: ['not split out'], pages: [], ms: 0 }));
    }
    console.log(`merged   ${d}: ${pdfs.length} docs -> ${results.length} results [${results.map((r) => `${r.docType}${JSON.stringify(r.pageRange)}`).join(', ')}]`);
  }
  await writeFile(path.join(outDir, '_merged_manifest.txt'), JSON.stringify(manifest, null, 1));
}
