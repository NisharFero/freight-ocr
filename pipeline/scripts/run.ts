import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { processFile } from '../src/pipeline';
import { crossCheck } from '../src/crossdoc';
const root = process.argv[2];
const only = process.argv[3];
const OUT = process.env.OUT ?? 'out/json';
await mkdir(OUT, { recursive: true });
for (const d of await readdir(root)) {
  const exs = [];
  for (const f of await readdir(path.join(root, d))) {
    if (only && !`${d}/${f}`.includes(only)) continue;
    const rs = await processFile(f, new Uint8Array(await readFile(path.join(root, d, f))));
    if (rs.length > 1) console.log(`\n!!! ${d}/${f} split into ${rs.length} documents: ${rs.map((x) => `${x.docType}${JSON.stringify(x.pageRange)}`).join(', ')}`);
    const r = rs[0];
    exs.push(...rs);
    await writeFile(path.join(OUT, `${d}__${f}.json`), JSON.stringify(r, null, 1));
    for (const [i, x] of rs.slice(1).entries()) await writeFile(path.join(OUT, `${d}__${f}#${i + 2}.json`), JSON.stringify(x, null, 1));
    const fl = Object.entries(r.fields).map(([k, v]) => `${k}=${JSON.stringify(v.value)}(${v.confidence}${v.valid === false ? '!' : ''})`).join('  ');
    console.log(`\n### ${d}/${f}  [${r.docType} ${r.docTypeConfidence}] ${r.ms}ms review=${r.needsReview}\n${fl}\nitems=${r.lineItems.length} ${JSON.stringify(r.lineItems.slice(0, 2))}\nreasons: ${r.reviewReasons.join(' | ')}`);
  }
  if (exs.length > 1) { const c = crossCheck(d, exs); console.log(`\n=== CROSS-CHECK ${d}: ${JSON.stringify(c.checks)}`); }
}
console.log(`\nmaxRSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
process.exit(0); // ONNX / worker handles keep the event loop alive
