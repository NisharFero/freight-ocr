// debug: run one perturbed variant through the full pipeline and print fields
import { readFile } from 'node:fs/promises';
import { makeVariant } from '../eval/perturb';
import { processFile } from '../src/pipeline';
const [file, variant] = process.argv.slice(2);
const v = await makeVariant(variant, file.split('/').pop()!, new Uint8Array(await readFile(file)));
const t = Date.now();
for (const r of await processFile(v.file, v.data)) {
  console.log(r.docType, r.pageRange, Date.now() - t, 'ms', r.pages.map((p: any) => p.reason ?? p.qa?.reason ?? JSON.stringify(p)).join(' | '));
  console.log(Object.entries(r.fields).map(([k, x]) => `${k}=${JSON.stringify(x.value)}(${x.confidence})`).join('  '));
  console.log('reasons:', r.reviewReasons.join(' | '));
}
