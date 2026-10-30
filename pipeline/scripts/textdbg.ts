// debug: full OCR text of a perturbed variant, grep for a pattern
import { readFile } from 'node:fs/promises';
import { makeVariant } from '../eval/perturb';
import { ingest } from '../src/ingest';
const [file, variant, pat] = process.argv.slice(2);
const v = await makeVariant(variant, file.split('/').pop()!, new Uint8Array(await readFile(file)));
const res = await ingest(v.file, v.data);
for (const p of res.pages) for (const l of p.lines) if (new RegExp(pat, 'i').test(l.text)) console.log(p.page, l.y.toFixed(3), JSON.stringify(l.text));
process.exit(0);
