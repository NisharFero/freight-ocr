import { NextResponse } from 'next/server';
import { computeMetrics } from '@/lib/monitor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/metrics?days=30 — live STP, per-field auto-accept precision / edit rate, drift alerts. */
export async function GET(req: Request) {
  const days = Number(new URL(req.url).searchParams.get('days') ?? 90);
  return NextResponse.json(await computeMetrics(Number.isFinite(days) && days > 0 ? days : 90));
}
