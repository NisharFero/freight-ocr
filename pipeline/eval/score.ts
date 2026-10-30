// Field-level evaluation of one output folder. Usage: tsx eval/score.ts [out/json] [eval/gold.json] [--json]
import { scoreDir } from './metrics';

const dir = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'out/json';
const goldPath = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'eval/gold.json';
const s = await scoreDir(dir, goldPath);
if (process.argv.includes('--json')) { const { _rows, ...rest } = s; console.log(JSON.stringify(rest, null, 1)); process.exit(0); }

const f = s.fields;
for (const m of s.missingOutputs.slice(0, 20)) console.log('missing output for', m);
for (const e of s.docTypeErrors) console.log('DOCTYPE', e);
console.log(`\nDocs ${s.docs}   doc-type accuracy ${s.docTypeAccuracy}%`);
console.log(`Fields scored: ${f.n}  TP ${f.TP}  wrong ${f.wrong}  missed ${f.missed}  false-pos ${f.falsePos}`);
console.log(`Precision ${f.precision}%  Recall ${f.recall}%  F1 ${f.f1}%`);
console.log(`Auto-accept (conf>=0.8): ${f.autoAcceptCorrect}/${f.autoAccepted} correct = ${f.autoAcceptPrecision}%   coverage ${f.coverage}%   catch rate ${f.catchRate}%`);
console.log(`STP (no review): ${s.stp.rate}% of docs, ${s.stp.precision}% of those fully correct; clean-doc rate ${s.stp.cleanDocRate}%`);
console.log(`Calibration ECE ${s.calibration.ece}: ${s.calibration.bins.map((b) => `[${b.range}] n=${b.n} acc=${b.accuracy}%`).join('  ')}`);
console.log(`Latency ms p50/p95: text ${s.latencyMs.textLayer.p50}/${s.latencyMs.textLayer.p95}  ocr ${s.latencyMs.ocr.p50}/${s.latencyMs.ocr.p95}`);
if (Object.keys(s.byVariant).length > 1) {
  console.log('\nPer variant:');
  for (const [k, v] of Object.entries(s.byVariant)) console.log(`  ${k.padEnd(10)} F1 ${String(v.f1).padStart(6)}  auto-accept ${v.autoAcceptCorrect}/${v.autoAccepted} = ${v.autoAcceptPrecision}%  catch ${v.catchRate}%`);
}
console.log('\nPer field (worst first):');
for (const [k, v] of Object.entries(s.byField).sort((a, b) => (a[1].f1 ?? 0) - (b[1].f1 ?? 0))) console.log(`  ${k.padEnd(24)} F1 ${String(v.f1).padStart(6)}  auto ${v.autoAcceptCorrect}/${v.autoAccepted}`);
console.log('\nErrors:');
for (const r of s._rows.filter((r) => !r.ok).slice(0, Number(process.env.MAX_ERRORS ?? 200)))
  console.log(`  [${r.kind}] ${(r.doc.split('/')[1] ?? r.doc).slice(0, 36).padEnd(36)} ${r.variant.padEnd(8)} ${r.field.padEnd(22)} gold=${JSON.stringify(r.gold)} pred=${JSON.stringify(r.pred)} conf=${r.conf ?? '-'}`);
