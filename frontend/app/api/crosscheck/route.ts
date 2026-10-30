import { NextResponse } from 'next/server';
import { crossCheck } from '@/lib/crossdoc';
import type { Extraction } from '@/lib/types';

export const runtime = 'nodejs';

/** POST { shipment, docs: Extraction[] } -> reconciliation checks across the shipment's documents. */
export async function POST(req: Request) {
  const body = (await req.json()) as { shipment?: string; docs: Extraction[] };
  return NextResponse.json(crossCheck(body.shipment ?? 'shipment', body.docs ?? []));
}
