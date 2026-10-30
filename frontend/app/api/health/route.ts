import { NextResponse } from 'next/server';
import { shadowMode, ACCEPT } from '@/lib/monitor';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET() {
  return NextResponse.json({ ok: true, node: process.version, rssMB: Math.round(process.memoryUsage().rss / 1e6), shadowMode: shadowMode(), acceptThreshold: ACCEPT });
}
