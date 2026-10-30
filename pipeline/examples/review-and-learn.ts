// What to call when a reviewer approves a document in YOUR product's review screen.
// 1) registerApproval teaches the layout registry (2 clean approvals -> that sender's layout may auto-accept)
// 2) append the approval to the feedback log -> computeMetrics() turns it into live per-field precision
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { registerApproval, computeMetrics, type Result } from '../src/index';

export async function onApprove(result: Result, corrected: Record<string, unknown>, reviewer: string) {
  const edits = Object.fromEntries(Object.entries(corrected).filter(([k, v]) => String(v ?? '') !== String(result.fields[k]?.value ?? '')));
  registerApproval(result.docType, Object.fromEntries(Object.entries(corrected).map(([k, v]) => [k, { value: v }])), Object.keys(edits).length > 0);
  const dir = process.env.FEEDBACK_DIR || path.join(process.cwd(), 'data', 'feedback');
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, `${new Date().toISOString().slice(0, 7)}.jsonl`), JSON.stringify({
    ts: new Date().toISOString(), fileName: result.fileName, docType: result.docType, reviewer,
    wouldAutoAccept: !result.needsReview, predicted: result.fields, corrected, edits,
  }) + '\n');
}

// e.g. a daily job / dashboard endpoint
export async function dailyReport() {
  const m = await computeMetrics(7);
  console.log('STP', m.stp.rate, 'auto-accept precision', m.fields.autoAcceptPrecision, 'alerts', m.alerts);
}
