import { readFile } from 'node:fs/promises';
import { getDocumentProxy, renderPageAsImage } from 'unpdf';
import { ppocr } from '../src/paddle';
import { preprocess } from '../src/ocr';
const [f, pg, filt] = process.argv.slice(2);
const pdf = await getDocumentProxy(new Uint8Array(await readFile(f)));
const png = await preprocess(Buffer.from(await renderPageAsImage(pdf as any, Number(pg), { canvasImport: () => import('@napi-rs/canvas'), scale: 2.5 })));
const b = await ppocr(png);
for (const x of b) if (!filt || new RegExp(filt, 'i').test(x.text)) console.log(x.y0.toFixed(3), x.y1.toFixed(3), 'h', ((x.y1 - x.y0) * 1000).toFixed(1), x.x0.toFixed(2), x.x1.toFixed(2), x.conf.toFixed(2), x.text);
