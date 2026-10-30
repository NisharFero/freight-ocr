// Access control for every page and API route (Next.js 16 "proxy", formerly middleware).
// HTTP Basic auth against AUTH_USERS = "alice:<sha256 hex>,bob:<sha256 hex>" (hash with `npm run hash-password`).
// The authenticated user name is forwarded to the routes as x-auth-user (stored with every approval = audit trail).
// /api/health stays open for the load balancer / monitoring. AUTH_DISABLED=1 only when an upstream SSO proxy
// already authenticates and sets x-auth-user itself.
import { NextResponse, type NextRequest } from 'next/server';

const enc = new TextEncoder();
async function sha256hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function users(): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of (process.env.AUTH_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(':');
    if (i > 0) m.set(pair.slice(0, i), pair.slice(i + 1).toLowerCase());
  }
  return m;
}
const deny = (msg: string, status = 401) =>
  new NextResponse(msg, { status, headers: status === 401 ? { 'WWW-Authenticate': 'Basic realm="Freight Doc Extractor", charset="UTF-8"' } : {} });

export async function proxy(req: NextRequest) {
  if (req.nextUrl.pathname === '/api/health') return NextResponse.next();
  const headers = new Headers(req.headers);
  headers.delete('x-auth-user'); // never trust a client-supplied identity
  if (process.env.AUTH_DISABLED === '1') {
    const upstream = req.headers.get(process.env.AUTH_USER_HEADER || 'x-forwarded-user');
    if (upstream) headers.set('x-auth-user', upstream);
    return NextResponse.next({ request: { headers } });
  }
  const table = users();
  if (!table.size) return deny('Authentication is not configured: set AUTH_USERS (or AUTH_DISABLED=1 behind an SSO proxy).', 503);
  const h = req.headers.get('authorization') ?? '';
  if (!h.startsWith('Basic ')) return deny('Authentication required');
  let user = '', pass = '';
  try { const raw = atob(h.slice(6)); const i = raw.indexOf(':'); user = raw.slice(0, i); pass = raw.slice(i + 1); } catch { return deny('Bad credentials'); }
  const want = table.get(user);
  const got = await sha256hex(pass);
  if (!want || !safeEqual(got, want)) return deny('Bad credentials');
  headers.set('x-auth-user', user);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
