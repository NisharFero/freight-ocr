// Deterministic validators + normalisers. These decide confidence and review routing.
import { INCOTERMS } from './gazetteer';

/** IATA AWB: 3-digit airline prefix + 7-digit serial + check digit (serial mod 7). */
export function validAwb(s: string): boolean {
  const d = s.replace(/\D/g, '');
  if (d.length !== 11) return false;
  return Number(d.slice(3, 10)) % 7 === Number(d[10]);
}
export function formatAwb(s: string): string { const d = s.replace(/\D/g, ''); return `${d.slice(0, 3)}-${d.slice(3)}`; }

/** ISO 6346 container number check digit. */
export function validContainer(s: string): boolean {
  const c = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]{3}[UJZ][0-9]{7}$/.test(c)) return false;
  const val = (ch: string) => {
    if (/\d/.test(ch)) return Number(ch);
    let v = ch.charCodeAt(0) - 55; // A=10
    for (const skip of [11, 22, 33]) if (v >= skip) v++;
    return v;
  };
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += val(c[i]) * 2 ** i;
  return (sum % 11) % 10 === Number(c[10]);
}

/** OCR confusion repair for numeric-ish fields. Only kept if the repaired value then validates. */
export function repairDigits(s: string): string {
  return s.replace(/[OoQD]/g, '0').replace(/[Il|!]/g, '1').replace(/[B]/g, '8').replace(/[S]/g, '5').replace(/[Z]/g, '2').replace(/[G]/g, '6');
}

/** Try to make a container number valid: fix digit-part confusions, then try missing check digit. */
export function fixContainer(raw: string): { value: string; valid: boolean; repaired: boolean } {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (validContainer(c)) return { value: c, valid: true, repaired: false };
  if (c.length >= 10) {
    const fixed = c.slice(0, 4).replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B') + repairDigits(c.slice(4, 11));
    if (validContainer(fixed)) return { value: fixed, valid: true, repaired: true };
  }
  return { value: c, valid: false, repaired: false };
}

export function normIncoterm(s: string): string | null {
  const t = s.toUpperCase().replace(/[^A-Z& -]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [k, v] of Object.entries(INCOTERMS)) {
    const re = new RegExp(`(^|\\W)${k.replace(/[-&]/g, (m) => '\\' + m).replace(/ /g, '\\s*')}(\\W|$)`);
    if (re.test(t) || t.replace(/ /g, '').startsWith(k.replace(/[ -]/g, ''))) return v;
  }
  return null;
}

export function normHs(s: string): string | null {
  const d = s.replace(/[.\s]/g, '');
  if (!/^\d{6,10}$/.test(d)) return null;
  const ch = Number(d.slice(0, 2));
  if (ch < 1 || ch > 97 || ch === 77) return null; // HS chapters 01-97, 77 reserved
  return d;
}

/**
 * Parse a localised number. Handles 1.302,00 (EU) / 1,302.00 (US) / 270,000 vs 7,168 ambiguity via `locale` hint.
 * Returns {value, ambiguous}.
 */
export function parseNumber(s: string, locale: 'eu' | 'us' | 'auto' = 'auto'): { value: number; ambiguous: boolean } | null {
  let t = s.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(t)) return null;
  t = t.replace(/^[.,]+|[.,]+$/g, '');
  const lastDot = t.lastIndexOf('.'), lastComma = t.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    return { value: Number(t.split(thou).join('').replace(dec, '.')), ambiguous: false };
  }
  const sep = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : '';
  if (!sep) return { value: Number(t), ambiguous: false };
  const parts = t.split(sep);
  if (parts.length > 2) {
    const last = parts[parts.length - 1];
    if (last.length !== 3) return { value: Number(parts.slice(0, -1).join('') + '.' + last), ambiguous: true }; // OCR "3.385.55" = 3,385.55
    return { value: Number(parts.join('')), ambiguous: false }; // 1.234.567
  }
  const after = parts[1];
  if (after.length !== 3) return { value: Number(parts.join('.')), ambiguous: false }; // 3,22 / 0,600? (0,600 has 3 -> handled below)
  // exactly 3 digits after a single separator: 7,168 (thousands) or 270,000 / 0,600 (3-decimals)
  if (parts[0].length > 3) return { value: Number(parts.join('.')), ambiguous: false }; // 12562.520 -> decimal
  if (/^0+$/.test(parts[0]) || parts[0] === '') return { value: Number(parts.join('.')), ambiguous: false }; // 0,600 -> 0.6
  if (locale === 'eu') return { value: sep === ',' ? Number(parts.join('.')) : Number(parts.join('')), ambiguous: true };
  if (locale === 'us') return { value: sep === ',' ? Number(parts.join('')) : Number(parts.join('.')), ambiguous: true };
  return { value: Number(parts.join('')), ambiguous: true };
}

/** Guess the number locale of a document from unambiguous patterns. */
export function detectLocale(text: string): 'eu' | 'us' | 'auto' {
  const eu = (text.match(/\d\.\d{3},\d{1,2}\b|\b\d+,\d{2}\b(?!\d)/g) ?? []).length;
  const us = (text.match(/\d,\d{3}\.\d{1,2}\b|\b\d+\.\d{2}\b(?!\d)/g) ?? []).length;
  if (eu > us * 1.5 && eu >= 2) return 'eu';
  if (us > eu * 1.5 && us >= 2) return 'us';
  return 'auto';
}

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12, MAI: 5, OKT: 10, DEZ: 12, MRZ: 3 };

/** Normalise a date to ISO yyyy-mm-dd. `us` = month-first preference for ambiguous dd/mm. */
export function parseDate(s: string, preferUS = false): { iso: string; ambiguous: boolean } | null {
  const t = s.toUpperCase().trim();
  let m = t.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return mk(+m[1], +m[2], +m[3], false);
  m = t.match(/(\d{1,2})[-/.\s]([A-Z]{3})[A-Z]*[-/.\s,]*(\d{2,4})/);
  if (m && MONTHS[m[2]]) return mk(yr(m[3]), MONTHS[m[2]], +m[1], false);
  m = t.match(/([A-Z]{3})[A-Z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1]]) return mk(+m[3], MONTHS[m[1]], +m[2], false);
  m = t.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const a = +m[1], b = +m[2], y = yr(m[3]);
    if (a > 12 && b <= 12) return mk(y, b, a, false);
    if (b > 12 && a <= 12) return mk(y, a, b, false);
    if (a === b) return mk(y, a, b, false);
    return preferUS ? mk(y, a, b, true) : mk(y, b, a, true);
  }
  return null;
  function yr(x: string) { const n = +x; return x.length === 2 ? 2000 + n : n; }
  function mk(y: number, mo: number, d: number, amb: boolean) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
    return { iso: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, ambiguous: amb };
  }
}

export const RE = {
  date: /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}[-\s][A-Za-z]{3,9}[-\s,]+\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\b/,
  po: /(?<!\d)45\d{8}(?!\d)/g, // client (NIMR) SAP PO numbers
  srn: /NIM[A-Z]{3}\d{6}(?!\d)/g, // forwarder shipment reference
  container: /\b[A-Z]{3}[UJZ][\s-]?\d{6}[\s-]?\d\b/g,
  awb: /\b(\d{3})[\s-]?(\d{4})[\s-]?(\d{4})\b/,
  hs: /\b\d{4}\.?\d{2}\.?\d{2,4}\b/g,
  weightKg: /(\d[\d.,]*)\s*(KGS?|KG'?S|KILOS?|K)\b/i,
};
