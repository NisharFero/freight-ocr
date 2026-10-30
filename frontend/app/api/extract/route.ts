import { NextResponse } from 'next/server';
import { processFile } from '@/lib/pipeline';
import { logExtraction, shadowMode } from '@/lib/monitor';
import { REQUIRED } from '@/lib/extract';

// Pilot: only fields listed here may be auto-accepted (comma list, e.g. "bl_number,consignee,gross_weight_kg").
// Unset = every field may. A document auto-accepts only if all its required fields are allowed.
const allowed = () => { const v = process.env.AUTO_ACCEPT_FIELDS?.trim(); return v ? new Set(v.split(',').map((s) => s.trim()).filter(Boolean)) : null; };

export const runtime = 'nodejs'; // ONNX Runtime / sharp need the Node runtime (not Edge)
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_BYTES = 25 * 1024 * 1024;
const OK_TYPES = /\.(pdf|png|jpe?g|tiff?|webp)$/i;

/**
 * POST multipart/form-data with one or more `file` fields. Returns one extraction per document found
 * (a PDF holding several documents of a shipment returns one result per document, with `pageRange` / `partOf`).
 * SHADOW_MODE=1: nothing is auto-accepted; `wouldAutoAccept` records what the pipeline would have done.
 */
// OCR runs one page at a time per process; cap queued uploads so a burst cannot exhaust memory.
const MAX_QUEUE = Number(process.env.MAX_QUEUE ?? 8);
let inFlight = 0;

export async function POST(req: Request) {
  if (inFlight >= MAX_QUEUE) return NextResponse.json({ error: `server busy: ${inFlight} uploads in progress, retry in a minute` }, { status: 429, headers: { 'Retry-After': '60' } });
  inFlight++;
  try { return await handle(req); } finally { inFlight--; }
}

async function handle(req: Request) {
  const user = req.headers.get('x-auth-user') ?? undefined;
  const form = await req.formData();
  const files = form.getAll('file').filter((f): f is File => typeof f !== 'string');
  if (!files.length) return NextResponse.json({ error: 'no file' }, { status: 400 });
  const engine = form.get('engine') === 'tesseract' ? 'tesseract' : 'paddle';
  const results = [];
  for (const f of files) {
    if (!OK_TYPES.test(f.name)) { results.push({ fileName: f.name, error: 'unsupported file type' }); continue; }
    if (f.size > MAX_BYTES) { results.push({ fileName: f.name, error: 'file too large (25 MB max)' }); continue; }
    try {
      for (const r of await processFile(f.name, new Uint8Array(await f.arrayBuffer()), { engine })) {
        const out = { ...r, wouldAutoAccept: !r.needsReview, shadow: shadowMode() };
        if (out.shadow && !r.needsReview) { out.needsReview = true; out.reviewReasons = [...r.reviewReasons, 'shadow mode: auto-accept disabled until the go-live gate passes']; }
        const allow = allowed();
        if (allow && !out.needsReview) {
          const blocked = (REQUIRED[r.docType] ?? []).filter((k) => !allow.has(k));
          if (blocked.length) { out.needsReview = true; out.reviewReasons = [...r.reviewReasons, `review-only field(s) in pilot: ${blocked.join(', ')}`]; }
        }
        results.push(out);
        await logExtraction({ ...out, user }).catch((e) => console.error('metrics log failed', e));
      }
    } catch (e) {
      console.error('extract failed', f.name, e);
      results.push({ fileName: f.name, error: String((e as Error).message ?? e) });
      await logExtraction({ fileName: f.name, user, error: String((e as Error).message ?? e) }).catch(() => {});
    }
  }
  return NextResponse.json({ results });
}
