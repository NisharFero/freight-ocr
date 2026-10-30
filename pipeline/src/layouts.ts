// Layout familiarity. Rules are reliable on layouts they have been checked against; on a new sender/layout an
// unvalidated value is a guess. Familiar = a known counterparty (gazetteer) or a fingerprint with enough approvals.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DocType, FieldValue } from './types';

const FILE = () => process.env.LAYOUT_REGISTRY || path.join(/* turbopackIgnore: true */ process.cwd(), 'data', 'layouts.json');
export const MIN_APPROVALS = Number(process.env.LAYOUT_MIN_APPROVALS ?? 2);

function load(): Record<string, number> {
  try { return JSON.parse(readFileSync(FILE(), 'utf8')); } catch { return {}; }
}

export function fingerprint(docType: DocType | string, fields: Record<string, FieldValue | { value: unknown }>): string {
  const who = String(fields.shipper?.value ?? fields.carrier_or_issuer?.value ?? fields.issuing_agent?.value ?? 'unknown');
  return `${docType}:${who.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24)}`;
}

export function isFamiliar(docType: DocType, fields: Record<string, FieldValue>): boolean {
  if (process.env.EVAL_COLD_START === '1') return false;
  const knownParty = ['shipper', 'carrier_or_issuer', 'issuing_agent'].some((k) => fields[k]?.method === 'gazetteer' || (fields[k]?.valid === true && k !== 'shipper') || (k === 'shipper' && fields[k]?.valid === true));
  if (knownParty) return true;
  return (load()[fingerprint(docType, fields)] ?? 0) >= MIN_APPROVALS;
}

/**
 * Called when a reviewer approves a document. Only an approval with NO corrections proves the rules read this
 * layout right; a corrected document resets the layout's count, so it keeps going to review until it reads clean.
 */
export function registerApproval(docType: string, fields: Record<string, { value: unknown }>, corrected = false): number {
  const reg = load();
  const fp = fingerprint(docType, fields);
  reg[fp] = corrected ? 0 : (reg[fp] ?? 0) + 1;
  mkdirSync(path.dirname(FILE()), { recursive: true });
  writeFileSync(FILE(), JSON.stringify(reg, null, 1));
  return reg[fp];
}
