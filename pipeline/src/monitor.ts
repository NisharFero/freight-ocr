// Production monitoring. Every extraction is logged to data/metrics/extractions-YYYY-MM.jsonl and every approval
// to data/feedback/YYYY-MM.jsonl. computeMetrics() turns the two logs into the numbers the release gates use on live
// traffic: per-field auto-accept precision and edit rate, STP, confidence mix, doc-type mix, latency, drift alerts.
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const ACCEPT = Number(process.env.ACCEPT_THRESHOLD ?? 0.8);
export const shadowMode = () => process.env.SHADOW_MODE === '1' || process.env.SHADOW_MODE === 'true';
const metricsDir = () => process.env.METRICS_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'data', 'metrics');
const feedbackDir = () => process.env.FEEDBACK_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'data', 'feedback');

export async function logExtraction(r: any) {
  const dir = metricsDir();
  await mkdir(dir, { recursive: true });
  const row = r.error ? { ts: new Date().toISOString(), fileName: r.fileName, user: r.user, error: r.error } : {
    ts: new Date().toISOString(), fileName: r.fileName, user: r.user, pageRange: r.pageRange, docType: r.docType, docTypeConfidence: r.docTypeConfidence,
    needsReview: r.needsReview, wouldAutoAccept: r.wouldAutoAccept, shadow: r.shadow, ms: r.ms,
    pages: (r.pages ?? []).map((p: any) => p.source), reasons: r.reviewReasons,
    conf: Object.fromEntries(Object.entries<any>(r.fields ?? {}).map(([k, v]) => [k, v.confidence])),
  };
  await appendFile(path.join(dir, `extractions-${row.ts.slice(0, 7)}.jsonl`), JSON.stringify(row) + '\n');
}

async function readJsonl(dir: string, prefix = ''): Promise<any[]> {
  let files: string[] = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl') && f.startsWith(prefix)).sort(); } catch { return []; }
  const rows: any[] = [];
  for (const f of files) for (const l of (await readFile(path.join(dir, f), 'utf8')).split('\n')) if (l.trim()) { try { rows.push(JSON.parse(l)); } catch { /* skip */ } }
  return rows;
}

const pct = (a: number, b: number) => (b ? Number(((a / b) * 100).toFixed(2)) : null);
const norm = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
const q = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

type FieldStat = { reviewed: number; edited: number; auto: number; autoCorrect: number };
function fieldStats(fb: any[]) {
  const by: Record<string, FieldStat> = {};
  for (const r of fb) {
    for (const [k, v] of Object.entries<any>(r.predicted ?? {})) {
      const s = (by[k] ??= { reviewed: 0, edited: 0, auto: 0, autoCorrect: 0 });
      const edited = r.edits && k in r.edits && norm(r.edits[k]) !== norm(v?.value);
      s.reviewed++; if (edited) s.edited++;
      if ((v?.confidence ?? 0) >= ACCEPT) { s.auto++; if (!edited) s.autoCorrect++; }
    }
  }
  return by;
}

/** Metrics over the logs. `days` limits the window; drift compares the last 7 days with the 28 days before. */
export async function computeMetrics(days = 90) {
  const now = Date.now();
  const since = (d: number) => (r: any) => now - Date.parse(r.ts) <= d * 86400e3;
  const ex = (await readJsonl(metricsDir(), 'extractions-')).filter(since(days));
  const fb = (await readJsonl(feedbackDir())).filter(since(days));
  const ok = ex.filter((r) => !r.error);
  const fields = fieldStats(fb);
  const per = Object.fromEntries(Object.entries(fields).map(([k, s]) => [k, {
    ...s, editRate: pct(s.edited, s.reviewed), autoAcceptPrecision: pct(s.autoCorrect, s.auto),
    // go-live rule: enable auto-accept for a field only with >= 200 observations at >= 99% precision
    eligibleForAutoAccept: s.auto >= 200 && (s.autoCorrect / s.auto) >= 0.99,
  }]));
  const allAuto = Object.values(fields).reduce((a, s) => [a[0] + s.auto, a[1] + s.autoCorrect], [0, 0]);
  // Doc-level: a doc the pipeline would have pushed is correct if the reviewer changed nothing.
  const wouldPush = fb.filter((r) => r.wouldAutoAccept);
  const confs = ok.flatMap((r) => Object.values<number>(r.conf ?? {}));
  const bucket = (lo: number, hi: number) => pct(confs.filter((c) => c >= lo && c < hi).length, confs.length);

  // Drift: edit rate per field, last 7 days vs the previous 28.
  const recent = fieldStats(fb.filter(since(7)));
  const prior = fieldStats(fb.filter((r) => !since(7)(r) && since(35)(r)));
  const alerts: string[] = [];
  for (const [k, s] of Object.entries(recent)) {
    const p = prior[k];
    if (s.reviewed < 10 || !p || p.reviewed < 20) continue;
    const r1 = s.edited / s.reviewed, r0 = p.edited / p.reviewed;
    if (r1 > Math.max(0.05, 2 * r0)) alerts.push(`${k}: edit rate ${(r1 * 100).toFixed(1)}% this week vs ${(r0 * 100).toFixed(1)}% before — a sender may have changed a template`);
  }
  const share = (rows: any[], pred: (r: any) => boolean) => (rows.length ? rows.filter(pred).length / rows.length : 0);
  const exRecent = ok.filter(since(7)), exPrior = ok.filter((r) => !since(7)(r) && since(35)(r));
  if (exRecent.length >= 20 && exPrior.length >= 50) {
    const o1 = share(exRecent, (r) => r.docType === 'OTHER'), o0 = share(exPrior, (r) => r.docType === 'OTHER');
    if (o1 > Math.max(0.05, 2 * o0)) alerts.push(`unclassified (OTHER) documents ${(o1 * 100).toFixed(1)}% vs ${(o0 * 100).toFixed(1)}% before`);
    const s1 = share(exRecent, (r) => !r.needsReview || r.wouldAutoAccept), s0 = share(exPrior, (r) => !r.needsReview || r.wouldAutoAccept);
    if (s0 > 0.2 && s1 < s0 * 0.7) alerts.push(`STP fell to ${(s1 * 100).toFixed(1)}% from ${(s0 * 100).toFixed(1)}%`);
  }
  const errs = ex.filter((r) => r.error).length;
  if (ex.length >= 20 && errs / ex.length > 0.02) alerts.push(`${errs} of ${ex.length} uploads failed to process`);

  return {
    window: { days, extractions: ex.length, approvals: fb.length, shadowMode: shadowMode(), acceptThreshold: ACCEPT },
    stp: {
      rate: pct(ok.filter((r) => r.wouldAutoAccept ?? !r.needsReview).length, ok.length),
      reviewedThatWouldHavePushed: wouldPush.length,
      pushPrecision: pct(wouldPush.filter((r) => !Object.keys(r.edits ?? {}).some((k) => norm(r.edits[k]) !== norm(r.predicted?.[k]?.value))).length, wouldPush.length),
    },
    fields: { autoAcceptPrecision: pct(allAuto[1], allAuto[0]), autoAccepted: allAuto[0], perField: per },
    confidence: { lt50: bucket(0, 0.5), '50-80': bucket(0.5, 0.8), '80-90': bucket(0.8, 0.9), '90+': bucket(0.9, 1.01) },
    docTypes: Object.fromEntries([...new Set(ok.map((r) => r.docType))].map((t) => [t, ok.filter((r) => r.docType === t).length])),
    routing: { ocrPages: pct(ok.flatMap((r) => r.pages ?? []).filter((s) => s === 'ocr').length, ok.flatMap((r) => r.pages ?? []).length), splitDocs: ok.filter((r) => r.pageRange && r.reasons?.some((x: string) => x.startsWith('split'))).length },
    latencyMs: { p50: q(ok.map((r) => r.ms), 0.5), p95: q(ok.map((r) => r.ms), 0.95) },
    errors: errs,
    alerts,
  };
}
