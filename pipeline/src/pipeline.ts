// End-to-end: ingest -> space recovery (OCR pages) -> split multi-doc PDFs -> classify -> extract -> validate/route.
import type { Extraction, PageData } from './types';
import { ingest, type IngestOptions } from './ingest';
import { classify } from './classify';
import { extractFields } from './extract';
import { loadDict, recoverSpaces } from './segment';
import { splitPages, renumber } from './split';

export type Result = Extraction & { classifierScores: Record<string, number>; pageRange?: [number, number]; partOf?: { file: string; part: number; parts: number } };

async function load(fileName: string, data: Uint8Array, opts: IngestOptions) {
  const res = await ingest(fileName, data, opts);
  const dict = await loadDict();
  for (const p of res.pages) {
    if (p.source !== 'ocr') continue;
    for (const l of p.lines) {
      for (const s of l.segments) s.text = recoverSpaces(s.text, dict);
      l.text = l.segments.map((s) => s.text).join('  ');
    }
  }
  return res.pages;
}

function run(fileName: string, pages: PageData[], ms: number): Result {
  const cls = classify(pages);
  const ex = extractFields(fileName, pages, cls.docType, cls.confidence, ms);
  return { ...ex, classifierScores: cls.scores };
}

/** One file -> one extraction per document found in it (a merged shipment PDF yields several). */
export async function processFile(fileName: string, data: Uint8Array, opts: IngestOptions = {}): Promise<Result[]> {
  const t0 = Date.now();
  const pages = await load(fileName, data, opts);
  const groups = process.env.SPLIT_DOCS === '0' ? [{ pages, range: [1, pages.length || 1] as [number, number] }] : splitPages(pages);
  if (groups.length === 1) return [{ ...run(fileName, pages, Date.now() - t0), pageRange: groups[0].range }];
  return groups.map((g, i) => {
    const r = run(fileName, renumber(g), Date.now() - t0);
    r.reviewReasons.push(`split from a ${groups.length}-document PDF (pages ${g.range[0]}-${g.range[1]})`);
    return { ...r, pageRange: g.range, partOf: { file: fileName, part: i + 1, parts: groups.length } };
  });
}

/** Single-document entry point (kept for callers that expect one result): the first document in the file. */
export async function processDocument(fileName: string, data: Uint8Array, opts: IngestOptions = {}): Promise<Result> {
  const t0 = Date.now();
  const pages = await load(fileName, data, opts);
  return { ...run(fileName, pages, Date.now() - t0), pageRange: [1, pages.length || 1] };
}
