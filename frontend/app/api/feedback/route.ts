import { NextResponse } from 'next/server';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { registerApproval } from '@/lib/layouts';

export const runtime = 'nodejs';

/**
 * Human-in-the-loop corrections. Every approved document (with any edited values) is appended to
 * data/feedback/YYYY-MM.jsonl. This file is the labelled dataset for later model training (GLiNER2 / LiLT).
 */
export async function POST(req: Request) {
  const body = await req.json();
  const dir = process.env.FEEDBACK_DIR || path.join(process.cwd(), 'data', 'feedback');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().slice(0, 7)}.jsonl`);
  // reviewer = the authenticated user (set by proxy.ts), never a value from the request body
  await appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...body, reviewer: req.headers.get('x-auth-user') ?? null }) + '\n');
  const approvals = body.docType && body.corrected ? registerApproval(body.docType, Object.fromEntries(Object.entries(body.corrected).map(([k, v]) => [k, { value: v }])), Object.keys(body.edits ?? {}).length > 0) : 0;
  return NextResponse.json({ ok: true, layoutApprovals: approvals });
}
