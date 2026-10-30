// Shipment-level reconciliation across documents (BL/AWB vs packing lists vs invoices).
import type { Extraction } from './types';

export interface Check { check: string; status: 'pass' | 'fail' | 'warn' | 'n/a'; detail: string }

const num = (e: Extraction, k: string) => (typeof e.fields[k]?.value === 'number' ? (e.fields[k].value as number) : null);
const list = (e: Extraction, k: string) => String(e.fields[k]?.value ?? '').split(/,\s*/).filter(Boolean);
const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Reconcile a shipment's documents. Agreement between independent documents is strong evidence, so fields
 * confirmed by a passing check get their confidence raised (and drop out of the review list).
 */
export function crossCheck(shipment: string, docs: Extraction[]): { shipment: string; checks: Check[]; docs: Extraction[] } {
  const checks: Check[] = [];
  const transport = docs.filter((d) => ['BILL_OF_LADING', 'TELEX_RELEASE', 'AIR_WAYBILL'].includes(d.docType));
  // the same goods are on the packing list and the invoice: sum one kind only, or they are counted twice
  const plOnly = docs.filter((d) => d.docType === 'PACKING_LIST');
  const pls = plOnly.length ? plOnly : docs.filter((d) => d.docType === 'COMMERCIAL_INVOICE');
  const comm = docs.filter((d) => d.docType === 'PACKING_LIST' || d.docType === 'COMMERCIAL_INVOICE');
  // transport document numbers quoted on the packing list / invoice must match the transport document
  for (const k of ['hawb_number', 'mawb_number', 'bl_number']) {
    const own = transport.map((d) => d.fields[k]?.value).filter(Boolean).map((v) => squash(String(v)));
    const quoted = comm.map((d) => d.fields[k]?.value).filter(Boolean).map((v) => squash(String(v)));
    if (!own.length || !quoted.length) continue;
    const bad = quoted.filter((q) => !own.includes(q));
    checks.push({ check: `${k.replace('_number', '').toUpperCase()} number on packing list / invoice = transport document`, status: bad.length ? 'fail' : 'pass', detail: bad.length ? `transport ${own.join(', ')} vs quoted ${[...new Set(bad)].join(', ')}` : own[0] });
    if (!bad.length) { for (const d of [...transport, ...comm]) confirm(d, k); }
  }

  const srns = new Set(docs.flatMap((d) => list(d, 'shipment_ref')));
  checks.push({ check: 'shipment reference consistent', status: srns.size === 0 ? 'n/a' : srns.size === 1 ? 'pass' : 'fail', detail: [...srns].join(', ') || 'no SRN found' });

  const cons = new Set(docs.map((d) => d.fields.consignee?.value).filter(Boolean).map((v) => squash(String(v)).slice(0, 12)));
  checks.push({ check: 'consignee consistent', status: cons.size <= 1 ? (cons.size ? 'pass' : 'n/a') : 'warn', detail: [...new Set(docs.map((d) => String(d.fields.consignee?.value ?? '')).filter(Boolean))].join(' | ') });

  const tPOs = new Set(transport.flatMap((d) => list(d, 'po_numbers')));
  const pPOs = new Set(pls.flatMap((d) => list(d, 'po_numbers')));
  if (tPOs.size && pPOs.size) {
    const missing = [...pPOs].filter((p) => !tPOs.has(p));
    checks.push({ check: 'packing-list POs covered by transport doc', status: missing.length ? 'warn' : 'pass', detail: missing.length ? `not on BL/AWB: ${missing.join(', ')}` : `${pPOs.size} PO(s) matched` });
  } else checks.push({ check: 'packing-list POs covered by transport doc', status: 'n/a', detail: 'PO numbers missing on one side' });

  for (const t of transport) {
    const g = num(t, 'gross_weight_kg');
    const sum = pls.map((d) => num(d, 'gross_weight_kg')).filter((x): x is number => x !== null);
    if (g !== null && sum.length) {
      const total = sum.reduce((a, b) => a + b, 0);
      const diff = Math.abs(total - g) / g;
      checks.push({ check: `gross weight ${t.fileName} vs packing lists`, status: diff <= 0.03 ? 'pass' : diff <= 0.1 ? 'warn' : 'fail', detail: `transport ${g} kg vs Σ packing lists ${total.toFixed(2)} kg (${sum.length} docs, Δ ${(diff * 100).toFixed(1)}%)` });
      if (diff <= 0.03) { confirm(t, 'gross_weight_kg'); for (const d of pls) confirm(d, 'gross_weight_kg'); }
    }
    const pk = num(t, 'total_packages') ?? num(t, 'pieces');
    const psum = pls.map((d) => num(d, 'total_packages')).filter((x): x is number => x !== null);
    if (pk !== null && psum.length) {
      const tot = psum.reduce((a, b) => a + b, 0);
      checks.push({ check: `packages ${t.fileName} vs packing lists`, status: tot === pk ? 'pass' : 'warn', detail: `transport ${pk} vs Σ packing lists ${tot}` });
      if (tot === pk) { confirm(t, t.fields.total_packages ? 'total_packages' : 'pieces'); for (const d of pls) confirm(d, 'total_packages'); }
    }
  }
  return { shipment, checks, docs };
}

function confirm(d: Extraction, field: string) {
  const f = d.fields[field];
  if (!f) return;
  f.confidence = Math.max(f.confidence, 0.95);
  f.issues = [...(f.issues ?? []), 'confirmed by cross-document check'];
  d.reviewReasons = d.reviewReasons.filter((r) => !r.includes(` ${field} `) && !r.endsWith(` ${field}`) && !r.includes(`${field} (`));
  d.needsReview = d.reviewReasons.length > 0;
}
