// Drop-in Next.js App Router route: app/api/extract/route.ts
// next.config.ts MUST externalise the native packages:
//   serverExternalPackages: ['freight-extract', 'onnxruntime-node', 'sharp', '@napi-rs/canvas', 'tesseract.js', 'unpdf',
//                            'an-array-of-english-words', '@nwpr/airport-codes', 'i18n-iso-countries', 'currency-codes']
import { NextResponse } from 'next/server';
import { processFile, logExtraction, shadowMode } from 'freight-extract';

export const runtime = 'nodejs'; // never 'edge': ONNX Runtime and sharp are native
export const maxDuration = 300;

export async function POST(req: Request) {
  const form = await req.formData();
  const results = [];
  for (const f of form.getAll('file').filter((x): x is File => typeof x !== 'string')) {
    for (const r of await processFile(f.name, new Uint8Array(await f.arrayBuffer()))) {
      const out = { ...r, wouldAutoAccept: !r.needsReview, needsReview: r.needsReview || shadowMode() };
      results.push(out);
      await logExtraction(out); // feeds computeMetrics() for live precision / drift alerts
    }
  }
  return NextResponse.json({ results });
}
