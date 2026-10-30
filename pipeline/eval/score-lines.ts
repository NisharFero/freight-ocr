// Scores line items, packages, containers and document HS codes against eval/gold_lineitems.json.
//   npx tsx eval/score-lines.ts <dir with <folder>__<file>.json>  [--docs] [--variant scan150]
// Per field: correct / wrong / missed / invented. "Invented" = a value output where the document prints none
// (e.g. an HS code on a line that has no HS code) – the error a reviewer is least likely to catch.
// Calibration: precision of cells scored >= 0.9 (the cells a reviewer would skip).
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'out/json';
const showDocs = process.argv.includes('--docs');
const vi = process.argv.indexOf('--variant');
const variant = vi > 0 ? `@${process.argv[vi + 1]}` : ''; // score a perturbation run (eval/perturb.ts output)
const gold: Record<string, any> = JSON.parse(readFileSync(path.join(import.meta.dirname, 'gold_lineitems.json'), 'utf8'));
const META = new Set(['scores', 'confidence', 'page', 'source', 'package_ref', 'po_ref', 'issues']);
const IGNORE = new Set(['nimr_part_number', 'supplier_order', 'ordered_qty', 'pcs_per_package', 'package_weight', 'ship_date']);

const norm = (v: any) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
function sim(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length, n = b.length; if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return 1 - prev[n] / Math.max(m, n);
}
function same(k: string, g: any, p: any): boolean {
  if (p == null) return false;
  if (typeof g === 'number') { const x = Number(p); return Number.isFinite(x) && Math.abs(x - g) <= Math.max(0.005, Math.abs(g) * 0.001); }
  const a = norm(g), b = norm(p);
  if (k === 'description') return sim(a, b) >= 0.9;
  if (k === 'line_no' || k === 'po_line') return a.replace(/^0+/, '') === b.replace(/^0+/, '');
  if (k === 'unit' || k === 'package_type') { const u = (x: string) => ({ PKG: 'PACKAGE', PLT: 'PALLET', CTN: 'CARTON', EA: 'EACH', PC: 'PCS', PIECE: 'PCS' } as Record<string, string>)[x.replace(/S$/, '')] ?? x.replace(/S$/, ''); return u(a) === u(b); }
  return a === b;
}
const val = (row: any, k: string) => row[k] ?? row[`${k === 'package_id' ? 'package' : k.replace(/_number$/, '')}_ref`];

type Stat = { n: number; ok: number; wrong: number; missed: number; invented: number };
const stats: Record<string, Record<string, Stat>> = { item: {}, package: {}, container: {} };
const st = (kind: string, k: string) => (stats[kind][k] ??= { n: 0, ok: 0, wrong: 0, missed: 0, invented: 0 });
const calib = { hi: 0, hiOk: 0, lo: 0, loOk: 0 };
const hsDoc = { ok: 0, missed: 0, invented: 0 };
const docRows: string[] = [];
const examples: string[] = [];

function align(gs: any[], ps: any[], keys: string[]): [any, any | null][] {
  // all pairs scored, best pairs taken first (an unmatched first row must not grab the second row's prediction)
  const pairs: [number, number, number][] = [];
  for (const [gi, g] of gs.entries()) for (const [pi, p] of ps.entries()) {
    let s = 0;
    for (const k of keys) if (g[k] != null && same(k, g[k], val(p, k))) s += k === 'description' || k === 'part_number' || k === 'container_number' || k === 'package_id' ? 2 : 1;
    if (s > 0) pairs.push([s - Math.abs(pi - gi) * 0.001, gi, pi]);
  }
  pairs.sort((a, b) => b[0] - a[0]);
  const gUsed = new Map<number, number>(), pUsed = new Set<number>();
  for (const [, gi, pi] of pairs) if (!gUsed.has(gi) && !pUsed.has(pi)) { gUsed.set(gi, pi); pUsed.add(pi); }
  const out: [any, any | null][] = gs.map((g, gi) => [g, gUsed.has(gi) ? ps[gUsed.get(gi)!] : null]);
  for (const [i, p] of ps.entries()) if (!pUsed.has(i)) out.push([null, p]);
  return out;
}

function score(kind: string, pairs: [any, any | null][], doc: string) {
  let err = 0;
  for (const [g, p] of pairs) {
    const keys = new Set([...Object.keys(g ?? {}), ...Object.keys(p ?? {})].filter((k) => !META.has(k) && !IGNORE.has(k)));
    for (const k of keys) {
      const gv = g?.[k]; const pv = p ? val(p, k) : undefined;
      const s = st(kind, k);
      if (gv != null) {
        s.n++;
        if (pv == null) { s.missed++; err++; if (examples.length < 400) examples.push(`MISSED   ${kind}.${k} ${doc}: ${JSON.stringify(gv)}`); }
        else if (same(k, gv, pv)) s.ok++;
        else { s.wrong++; err++; if (examples.length < 400) examples.push(`WRONG    ${kind}.${k} ${doc}: gold ${JSON.stringify(gv)} got ${JSON.stringify(pv)} (score ${p?.scores?.[k] ?? '–'})`); }
      } else if (p?.[k] != null) { s.invented++; err++; if (examples.length < 400) examples.push(`INVENTED ${kind}.${k} ${doc}: ${JSON.stringify(p[k])} (score ${p?.scores?.[k] ?? '–'})`); }
      const sc = p?.scores?.[k];
      if (p?.[k] != null && sc != null && gv != null) {
        const ok = same(k, gv, p[k]);
        if (sc >= 0.9) { calib.hi++; if (ok) calib.hiOk++; } else { calib.lo++; if (ok) calib.loOk++; }
      } else if (p?.[k] != null && sc != null && gv == null) { if (sc >= 0.9) calib.hi++; else calib.lo++; }
    }
  }
  return err;
}

for (const [key, g] of Object.entries(gold)) {
  if (key.startsWith('_')) continue;
  const [folder, file] = key.split('/');
  const f = path.join(dir, `${folder}__${file}${variant}.json`);
  if (!existsSync(f)) { docRows.push(`${key}: NO OUTPUT`); continue; }
  const r = JSON.parse(readFileSync(f, 'utf8'));
  const e1 = score('item', align(g.items ?? [], r.lineItems ?? [], ['part_number', 'customer_part_number', 'description', 'quantity', 'line_no', 'po_line', 'hs_code', 'package_id']), key);
  const e2 = score('package', align(g.packages ?? [], r.packages ?? [], ['package_id', 'dimensions_cm', 'dimensions_in', 'gross_kg', 'count']), key);
  const e3 = score('container', align(g.containers ?? [], r.containers ?? [], ['container_number']), key);
  const ghs = new Set<string>(g.doc_hs_codes ?? []);
  const phs = new Set(String(r.fields?.hs_codes?.value ?? '').split(/,\s*/).filter(Boolean));
  let e4 = 0;
  for (const h of ghs) if (phs.has(h)) hsDoc.ok++; else { hsDoc.missed++; e4++; examples.push(`MISSED   doc.hs_codes ${key}: ${h}`); }
  for (const h of phs) if (!ghs.has(h)) { hsDoc.invented++; e4++; examples.push(`INVENTED doc.hs_codes ${key}: ${h}`); }
  docRows.push(`${String(e1 + e2 + e3 + e4).padStart(4)} errors  items ${String((r.lineItems ?? []).length).padStart(2)}/${String((g.items ?? []).length).padEnd(2)} pkgs ${String((r.packages ?? []).length).padStart(2)}/${String((g.packages ?? []).length).padEnd(2)} cont ${(r.containers ?? []).length}/${(g.containers ?? []).length}  ${key}`);
}

const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : '–').padStart(6);
let T = { n: 0, ok: 0, wrong: 0, missed: 0, invented: 0 };
for (const [kind, fs] of Object.entries(stats)) {
  console.log(`\n${kind.toUpperCase()}  field                 gold  correct  wrong missed invented  recall  precision`);
  for (const [k, s] of Object.entries(fs).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${k.padEnd(28)} ${String(s.n).padStart(5)} ${String(s.ok).padStart(7)} ${String(s.wrong).padStart(6)} ${String(s.missed).padStart(6)} ${String(s.invented).padStart(8)} ${pct(s.ok, s.n)} ${pct(s.ok, s.ok + s.wrong + s.invented)}`);
    T = { n: T.n + s.n, ok: T.ok + s.ok, wrong: T.wrong + s.wrong, missed: T.missed + s.missed, invented: T.invented + s.invented };
  }
}
console.log(`\nDOC HS codes: correct ${hsDoc.ok}, missed ${hsDoc.missed}, invented ${hsDoc.invented}`);
console.log(`ALL cells: gold ${T.n}, correct ${T.ok}, wrong ${T.wrong}, missed ${T.missed}, invented ${T.invented}  ->  recall ${pct(T.ok, T.n)}%  precision ${pct(T.ok, T.ok + T.wrong + T.invented)}%`);
console.log(`Scores: cells >= 0.90 correct ${calib.hiOk}/${calib.hi} (${pct(calib.hiOk, calib.hi)}%), cells < 0.90 correct ${calib.loOk}/${calib.lo}`);
if (showDocs) { console.log('\nPER DOCUMENT (got/gold)'); for (const r of docRows) console.log(r); console.log('\nERRORS'); for (const e of examples) console.log(e); }
