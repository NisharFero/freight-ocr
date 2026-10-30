import { readFile } from 'node:fs/promises';
import { ingest } from '../src/ingest';
const [f, pg, force] = process.argv.slice(2);
const r = await ingest(f, new Uint8Array(await readFile(f)), { forceOcr: force === 'ocr' });
for (const p of r.pages) if (!pg || String(p.page) === pg) { console.log('#### page', p.page, p.source, p.qa.reason); for (const l of p.lines) console.log(l.y.toFixed(3), l.segments.map(s => `[${s.x0.toFixed(2)}-${s.x1.toFixed(2)}] ${s.text}`).join(' ¦ ')); }
