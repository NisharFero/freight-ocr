// Live-metrics computation from the extraction + feedback logs (shadow mode / pilot gate / drift alerts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('computeMetrics: per-field auto-accept precision, push precision, drift alert', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fo-mon-'));
  process.env.METRICS_DIR = path.join(dir, 'm');
  process.env.FEEDBACK_DIR = path.join(dir, 'f');
  const { computeMetrics, logExtraction } = await import('../src/monitor');
  const now = Date.now();
  const day = 86400e3;
  const fb: string[] = [];
  // 40 approvals 2-5 weeks ago: bl_number never edited; 12 this week: bl_number edited in 6 (template change)
  for (let i = 0; i < 52; i++) {
    const recent = i >= 40;
    const ts = new Date(now - (recent ? 2 : 10 + (i % 20)) * day).toISOString();
    const edited = recent && i % 2 === 0;
    fb.push(JSON.stringify({ ts, docType: 'BILL_OF_LADING', wouldAutoAccept: !edited, predicted: { bl_number: { value: 'ABC123', confidence: 0.9 }, vessel: { value: 'MSC X', confidence: 0.7 } }, edits: edited ? { bl_number: 'ABC128' } : {} }));
  }
  const { mkdir } = await import('node:fs/promises');
  await mkdir(process.env.FEEDBACK_DIR!, { recursive: true });
  await writeFile(path.join(process.env.FEEDBACK_DIR!, '2026-10.jsonl'), fb.join('\n') + '\n');
  await logExtraction({ fileName: 'a.pdf', docType: 'BILL_OF_LADING', needsReview: true, wouldAutoAccept: true, shadow: true, ms: 1200, pages: [{ source: 'ocr' }], reviewReasons: [], fields: { bl_number: { confidence: 0.9 } } });

  const m = await computeMetrics(90);
  assert.equal(m.window.approvals, 52);
  assert.equal(m.fields.perField.bl_number.auto, 52);
  assert.equal(m.fields.perField.bl_number.edited, 6);
  assert.equal(m.fields.perField.vessel.auto, 0); // below threshold: reviewed, never auto-accepted
  assert.equal(m.fields.perField.bl_number.eligibleForAutoAccept, false); // < 200 observations
  assert.equal(m.stp.reviewedThatWouldHavePushed, 46);
  assert.equal(m.stp.pushPrecision, 100);
  assert.ok(m.alerts.some((a) => a.startsWith('bl_number')), JSON.stringify(m.alerts));
  assert.equal(m.window.extractions, 1);
});
