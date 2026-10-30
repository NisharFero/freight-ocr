// Extract every PDF/image passed on the command line and print the fields.
//   npx tsx examples/cli.ts path/to/BL.pdf path/to/invoice.pdf
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { processFile, crossCheck, warmup, type Result } from '../src/index';

await warmup();
const all: Result[] = [];
for (const file of process.argv.slice(2)) {
  for (const r of await processFile(path.basename(file), new Uint8Array(await readFile(file)))) {
    all.push(r);
    console.log(`\n${file}  ->  ${r.docType} (${r.docTypeConfidence})  pages ${r.pageRange?.join('-')}  ${r.ms} ms  ${r.needsReview ? 'REVIEW' : 'AUTO-ACCEPT'}`);
    for (const [k, v] of Object.entries(r.fields)) console.log(`  ${k.padEnd(26)} ${String(v.value).slice(0, 60).padEnd(60)} ${v.confidence}${v.valid === true ? ' ✓' : ''}`);
    if (r.reviewReasons.length) console.log('  review:', r.reviewReasons.join(' | '));
  }
}
if (all.length > 1) console.log('\ncross-check:', crossCheck('batch', all).checks.map((c) => `${c.status} ${c.check}`).join('; '));
process.exit(0); // ONNX Runtime keeps worker threads alive
