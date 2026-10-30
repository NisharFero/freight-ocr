// Release gate. Scores every eval set, checks absolute targets and regression against eval/baseline.json,
// writes out/gate-report.json and exits 1 if any check fails.
//   tsx eval/gate.ts                 score existing outputs (run `npm run eval:all` first)
//   tsx eval/gate.ts --update-baseline   accept current numbers as the new baseline (after a reviewed improvement)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { scoreDir, type Score } from './metrics';

type Target = { metric: string; min?: number; max?: number };
type SetCfg = { dir: string; gold: string; required?: boolean; targets: Target[]; note: string };
const cfg: { tolerance: number; sets: Record<string, SetCfg>; baseline: Record<string, Record<string, number>> } =
  JSON.parse(await readFile('eval/baseline.json', 'utf8'));

const get = (s: Score, metric: string): number | null => {
  const v = metric.split('.').reduce<any>((o, k) => (o == null ? o : o[k]), s);
  return typeof v === 'number' ? v : null;
};
// Metrics where lower is better (latency, calibration error).
const lowerBetter = (m: string) => /latency|ece|missingOutputs/i.test(m);

const report: any = { ts: new Date().toISOString(), node: process.version, sets: {}, checks: [] as any[] };
let failed = 0;
const check = (set: string, metric: string, value: number | null, ok: boolean, rule: string) => {
  report.checks.push({ set, metric, value, rule, ok });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${set.padEnd(10)} ${metric.padEnd(34)} ${String(value ?? '-').padStart(8)}  ${rule}`);
};

for (const [name, s] of Object.entries(cfg.sets)) {
  const sc = await scoreDir(s.dir, s.gold);
  const { _rows, ...rest } = sc;
  report.sets[name] = rest;
  if (!sc.docs) {
    if (s.required) check(name, 'docs', 0, false, `no outputs in ${s.dir}`);
    else console.log(`SKIP  ${name.padEnd(10)} no outputs in ${s.dir}`);
    continue;
  }
  console.log(`\n# ${name}: ${sc.docs} docs — ${s.note}`);
  for (const t of s.targets) {
    // per-variant / per-docType targets: "byVariant.*.autoAcceptPrecision"
    if (t.metric.includes('*')) {
      const [grp, , m] = t.metric.split('.');
      for (const [k, v] of Object.entries<any>((sc as any)[grp] ?? {})) {
        const val = v[m];
        if (val == null || (v.autoAccepted ?? 1) === 0) continue;
        check(name, `${grp}.${k}.${m}`, val, (t.min == null || val >= t.min) && (t.max == null || val <= t.max), t.min != null ? `>= ${t.min}` : `<= ${t.max}`);
      }
      continue;
    }
    const v = get(sc, t.metric);
    if (v == null) { console.log(`n/a   ${name.padEnd(10)} ${t.metric}`); continue; }
    check(name, t.metric, v, (t.min == null || v >= t.min) && (t.max == null || v <= t.max), t.min != null ? `>= ${t.min}` : `<= ${t.max}`);
  }
  // regression vs baseline
  for (const [metric, base] of Object.entries(cfg.baseline[name] ?? {})) {
    const v = get(sc, metric);
    if (v == null) continue;
    const tol = /latency/i.test(metric) ? Math.max(base * 0.25, 200) : cfg.tolerance;
    const ok = lowerBetter(metric) ? v <= base + tol : v >= base - tol;
    if (!ok || process.env.GATE_VERBOSE) check(name, `regression:${metric}`, v, ok, `${lowerBetter(metric) ? '<=' : '>='} baseline ${base} ${lowerBetter(metric) ? '+' : '-'} ${tol}`);
  }
  if (sc.autoAcceptedErrors.length) {
    console.log(`  auto-accepted errors (${sc.autoAcceptedErrors.length}):`);
    for (const e of sc.autoAcceptedErrors.slice(0, 15)) console.log(`    ${e.doc.slice(0, 60)} ${e.field} gold=${JSON.stringify(e.gold)} pred=${JSON.stringify(e.pred)} conf=${e.conf}`);
  }
  if (sc.docTypeErrors.length) console.log(`  doc-type errors: ${sc.docTypeErrors.slice(0, 10).join(' | ')}`);
}

await mkdir('out', { recursive: true });
await writeFile('out/gate-report.json', JSON.stringify(report, null, 1));

if (process.argv.includes('--update-baseline')) {
  const tracked = ['docTypeAccuracy', 'fields.f1', 'fields.precision', 'fields.recall', 'fields.autoAcceptPrecision', 'fields.catchRate', 'fields.coverage', 'stp.rate', 'stp.cleanDocRate', 'calibration.ece'];
  for (const name of Object.keys(report.sets)) {
    if (!report.sets[name].docs) continue;
    cfg.baseline[name] = Object.fromEntries(tracked.map((m) => [m, get(report.sets[name], m)]).filter(([, v]) => v != null));
  }
  await writeFile('eval/baseline.json', JSON.stringify(cfg, null, 1));
  console.log('\nbaseline updated');
}
console.log(`\n${failed ? `GATE FAILED: ${failed} check(s)` : 'GATE PASSED'}  — report: out/gate-report.json`);
process.exit(failed ? 1 : 0);
