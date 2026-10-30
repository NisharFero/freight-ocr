// Minimal HTTP service around the pipeline using only node:http (no framework).
//   npx tsx examples/http-server.ts      then: curl -F file=@BL.pdf localhost:8080/extract
// Production: put auth + TLS in front (see the freight-ocr app's proxy.ts and deploy/nginx config).
import http from 'node:http';
import { processFile, warmup } from '../src/index';

await warmup();
const MAX = 25 * 1024 * 1024;
let busy = 0;

http.createServer(async (req, res) => {
  const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
  if (req.method !== 'POST' || !req.url?.startsWith('/extract')) return send(404, { error: 'not found' });
  if (busy >= 8) return send(429, { error: 'busy' });
  busy++;
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX) return send(413, { error: 'file too large' }); chunks.push(c as Buffer); }
    // Accepts raw bytes (Content-Type: application/pdf | image/*) with ?name=file.pdf, or multipart via the Fetch API parser
    const url = new URL(req.url, 'http://x');
    let name = url.searchParams.get('name') ?? 'upload.pdf', data = new Uint8Array(Buffer.concat(chunks));
    if ((req.headers['content-type'] ?? '').startsWith('multipart/form-data')) {
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type']! } }).formData();
      const f = form.get('file') as File; name = f.name; data = new Uint8Array(await f.arrayBuffer());
    }
    send(200, { results: await processFile(name, data) });
  } catch (e) { send(500, { error: String((e as Error).message ?? e) }); } finally { busy--; }
}).listen(8080, '127.0.0.1', () => console.log('freight-extract on http://127.0.0.1:8080'));
