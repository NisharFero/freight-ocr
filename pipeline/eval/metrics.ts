// Shared scoring for every eval set. Compares pipeline outputs (<dir>/<folder>__<file>[@variant].json) with gold labels
// ({ "<folder>/<file>": { docType, field: value | null } }) and returns production-oriented metrics:
// field P/R/F1, auto-accept precision, catch rate, STP, coverage, calibration (ECE + bins), risk-coverage, latency.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolvePort } from '../src/gazetteer';

export const ACCEPT = 0.8;
const sq = (v: unknown) => String(v ?? '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/g, '');
const asList = (v: unknown) => (Array.isArray(v) ? v : String(v ?? '').split(/,\s*/)).map(sq).filter(Boolean).sort();
const PORT_FIELDS = new Set(['port_of_loading', 'port_of_discharge', 'place_of_receipt', 'place_of_delivery']);

export function match(g: unknown, p: unknown, field = ''): boolean {
  if (PORT_FIELDS.has(field) && typeof g === 'string' && p) { const a = resolvePort(g), b = resolvePort(String(p)); if (a && b && a.locode === b.locode && !/VIA/i.test(g)) return true; }
  if (typeof g === 'number') { const n = Number(p); return isFinite(n) && Math.abs(n - g) <= Math.max(0.005 * Math.abs(g), 0.011); }
  if (Array.isArray(g)) { const a = asList(g), b = asList(p); return a.length === b.length && a.every((x, i) => x === b[i]); }
  return sq(g) === sq(p);
}

export type Kind = 'TP' | 'WRONG' | 'MISS' | 'FP' | 'TN';
export type Row = { doc: string; variant: string; docType: string; sender: string; field: string; gold: unknown; pred: unknown; conf?: number; ok: boolean; kind: Kind };
export type DocRow = { doc: string; variant: string; docTypeOk: boolean; goldType: string; predType: string; needsReview: boolean; allCorrect: boolean; pushedCorrect: boolean; cleanAuto: boolean; ms: number; ocr: boolean };

const pct = (a: number, b: number) => (b ? Number(((a / b) * 100).toFixed(2)) : null);

function prf(rows: Row[]) {
  const c = (k: Kind) => rows.filter((r) => r.kind === k).length;
  const TP = c('TP'), W = c('WRONG'), M = c('MISS'), FP = c('FP');
  const p = TP / (TP + W + FP || 1), r = TP / (TP + W + M || 1);
  const acc = rows.filter((x) => x.conf !== undefined && x.conf >= ACCEPT);
  const errors = rows.filter((x) => x.kind === 'WRONG' || x.kind === 'FP');
  return {
    n: rows.length, TP, wrong: W, missed: M, falsePos: FP,
    precision: pct(TP, TP + W + FP), recall: pct(TP, TP + W + M), f1: p + r ? Number(((2 * p * r) / (p + r) * 100).toFixed(2)) : 0,
    autoAccepted: acc.length, autoAcceptCorrect: acc.filter((x) => x.ok).length, autoAcceptPrecision: pct(acc.filter((x) => x.ok).length, acc.length),
    catchRate: pct(errors.filter((x) => (x.conf ?? 0) < ACCEPT).length, errors.length),
    coverage: pct(acc.length, rows.filter((x) => x.pred !== undefined).length),
  };
}

function calibration(rows: Row[]) {
  const pred = rows.filter((r) => r.conf !== undefined);
  const edges = [0, 0.5, 0.7, 0.8, 0.9, 1.0001];
  const bins = edges.slice(0, -1).map((lo, i) => {
    const b = pred.filter((r) => r.conf! >= lo && r.conf! < edges[i + 1]);
    const conf = b.reduce((s, r) => s + r.conf!, 0) / (b.length || 1);
    return { range: `${lo}-${Math.min(edges[i + 1], 1)}`, n: b.length, meanConf: Number(conf.toFixed(3)), accuracy: pct(b.filter((r) => r.ok).length, b.length) };
  });
  const ece = bins.reduce((s, b) => s + (b.n / (pred.length || 1)) * Math.abs((b.accuracy ?? 0) / 100 - b.meanConf), 0);
  // risk-coverage: what precision/coverage each threshold would give (choose per-field thresholds from this).
  const riskCoverage = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95].map((t) => {
    const a = pred.filter((r) => r.conf! >= t);
    return { threshold: t, coverage: pct(a.length, pred.length), precision: pct(a.filter((r) => r.ok).length, a.length) };
  });
  return { ece: Number(ece.toFixed(4)), bins, riskCoverage };
}

function quantile(xs: number[], q: number) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function groupBy<T>(xs: T[], key: (x: T) => string) {
  const m = new Map<string, T[]>();
  for (const x of xs) { const k = key(x); m.set(k, [...(m.get(k) ?? []), x]); }
  return m;
}

export async function scoreDir(dir: string, goldPath: string) {
  const gold = JSON.parse(await readFile(goldPath, 'utf8'));
  for (const k of Object.keys(gold)) if (k.startsWith('_')) delete gold[k];
  let files: string[] = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.json')); } catch { /* no outputs yet */ }
  const rows: Row[] = [];
  const docs: DocRow[] = [];
  const missingOutputs: string[] = [];
  const seen = new Set<string>();
  for (const fn of files) {
    const stem = fn.slice(0, -5);
    const at = stem.lastIndexOf('@');
    const base = at > 0 ? stem.slice(0, at) : stem;
    const variant = at > 0 ? stem.slice(at + 1) : 'original';
    const key = base.replace('__', '/');
    const g = gold[key];
    if (!g) continue;
    seen.add(key);
    const out = JSON.parse(await readFile(path.join(dir, fn), 'utf8'));
    const sender = String(g.shipper ?? g.carrier_or_issuer ?? g.issuing_agent ?? key.split('/')[0]).slice(0, 40);
    const docRows: Row[] = [];
    for (const [field, gv] of Object.entries<unknown>(g)) {
      if (field === 'docType') continue;
      const pf = out.fields?.[field];
      let kind: Kind;
      if (gv === null) kind = pf ? 'FP' : 'TN';
      else if (!pf) kind = 'MISS';
      else kind = match(gv, pf.value, field) ? 'TP' : 'WRONG';
      docRows.push({ doc: key, variant, docType: g.docType, sender, field, gold: gv, pred: pf?.value, conf: pf?.confidence, ok: kind === 'TP' || kind === 'TN', kind });
    }
    rows.push(...docRows);
    const allCorrect = docRows.every((r) => r.ok);
    // what an auto-accepted doc pushes: fields at/above threshold. A blank (miss) is not a wrong push.
    const pushedCorrect = docRows.every((r) => r.ok || r.kind === 'MISS' || (r.conf ?? 0) < ACCEPT);
    docs.push({
      doc: key, variant, goldType: g.docType, predType: out.docType, docTypeOk: out.docType === g.docType, needsReview: !!out.needsReview,
      allCorrect, pushedCorrect, cleanAuto: allCorrect && docRows.every((r) => r.kind === 'TN' || (r.conf ?? 0) >= ACCEPT),
      ms: out.ms ?? 0, ocr: (out.pages ?? []).some((p: any) => p.source === 'ocr'),
    });
  }
  for (const k of Object.keys(gold)) if (!seen.has(k)) missingOutputs.push(k);

  const stpDocs = docs.filter((d) => !d.needsReview && d.docTypeOk);
  const per = <K extends string>(by: (r: Row) => K) => Object.fromEntries([...groupBy(rows, by)].map(([k, rs]) => [k, prf(rs)]));
  return {
    dir, gold: goldPath, docs: docs.length, missingOutputs,
    docTypeAccuracy: pct(docs.filter((d) => d.docTypeOk).length, docs.length),
    fields: prf(rows),
    stp: {
      // pushed with no human touch: needsReview=false
      rate: pct(stpDocs.length, docs.length),
      // of the docs pushed without review, how many pushed no wrong value (the number the client system feels)
      precision: pct(stpDocs.filter((d) => d.pushedCorrect).length, stpDocs.length),
      // of those, how many also had every labelled field filled (blanks are completed later in the client system)
      complete: pct(stpDocs.filter((d) => d.allCorrect).length, stpDocs.length),
      // every gold field right and above threshold (upper bound on STP)
      cleanDocRate: pct(docs.filter((d) => d.cleanAuto).length, docs.length),
    },
    calibration: calibration(rows),
    latencyMs: {
      textLayer: { p50: quantile(docs.filter((d) => !d.ocr).map((d) => d.ms), 0.5), p95: quantile(docs.filter((d) => !d.ocr).map((d) => d.ms), 0.95) },
      ocr: { p50: quantile(docs.filter((d) => d.ocr).map((d) => d.ms), 0.5), p95: quantile(docs.filter((d) => d.ocr).map((d) => d.ms), 0.95) },
    },
    byField: per((r) => r.field),
    byDocType: per((r) => r.docType),
    bySender: per((r) => r.sender),
    byVariant: per((r) => r.variant),
    docTypeErrors: docs.filter((d) => !d.docTypeOk).map((d) => `${d.doc}@${d.variant}: ${d.goldType} -> ${d.predType}`),
    autoAcceptedErrors: rows.filter((r) => !r.ok && (r.conf ?? 0) >= ACCEPT).map((r) => ({ doc: `${r.doc}@${r.variant}`, field: r.field, gold: r.gold, pred: r.pred, conf: r.conf })),
    _rows: rows,
  };
}
export type Score = Awaited<ReturnType<typeof scoreDir>>;
