// Line items, packages and containers. Rules only, no training.
//  A) header-column tables: each word is put under the header column it sits below. Headers may be merged into one
//     text run ("Net Wt (kg) Gross Wt (kg) Dims (cm) CBM") or stacked on two lines ("Line / Number", "Weight / Net Gross").
//     A row that only carries package columns (id, type, dims, gross) is a package (pallet/carton/box), not an item.
//  B) label blocks: "1  20004136R0 ... 18,00 / description / Country of Origin: X  PO-Line: 10 / Customs Tariffnumber: N"
//  C) free text: "Total colli: 2 pallets 120x80x55cm - 160kg", "Pallet Size 120 cm x 80cm x 70cm", "3 pallets ... 48"x40"x55""
//  D) BL containers: "40HD/CMAU6525747/R5401959/.../53PACKAGE(S)/12562.520KGS/22.0000CBM", "Container: MSDU 135046-7 (20 DV) Seal: X"
// Every value carries a score (0..1) in `scores`; `confidence` is the row's lowest score. A value is only output when it
// is printed for that row: an HS code needs an HS / tariff column or label on that item (a header "Tariff Code:" stays a
// document-level field and is never copied onto lines).
import type { Doc } from './anchors';
import type { Line, LineItem, Segment } from './types';
import { parseNumber, normHs, validContainer } from './validators';
import { resolveCountry } from './gazetteer';

type Locale = 'eu' | 'us' | 'auto';
export interface LineCheck { check: string; status: 'pass' | 'fail' | 'n/a'; detail: string }
export interface LineResult { lineItems: LineItem[]; packages: LineItem[]; containers: LineItem[]; checks: LineCheck[] }

// ---------------------------------------------------------------- vocabulary (order = priority) ----
const VOCAB: [string, RegExp][] = [
  ['customer_part_number', /CUSTOMER\s*PART\s*(NO\.?|NUMBER|#)?|CUST\.?\s*PART\s*(NO\.?)?/i],
  ['ordered_qty', /(LINE|ORDER(ED)?)\s*QUANTITY|QTY\s*ORDERED/i],
  ['package_count', /(NUMBER|NO\.?)\s*(&|AND)\s*KIND(\s*OF\s*PACK\S*)?|NO\.?\s*OF\s*(PACKAGES|PKGS|CTNS|CARTONS|PALLETS)|\bCOUNT\b\.?|\bCTNS\b/i],
  ['package_type', /ART\s*DES\s*PACK\S*|PACKAGE\s*TYPE|TYPE\s*OF\s*PACK\S*|KIND\s*OF\s*PACK\S*/i],
  ['pcs_per_package', /CTN\s*\/\s*PCS|PCS\s*\/\s*CTN|PCS\s*PER\s*(CTN|CARTON|BOX)/i],
  ['package_weight', /CTN\s*W\.?\s*(\(KG\))?|CARTON\s*WEIGHT/i],
  ['po_line', /PO[-\s]*LINE|PO\s*POS/i],
  ['po_number', /CUSTOMER\s*PO(\s*(NO\.?|NUMBER))?|\bPO\s*(NO\.?|NUMBER|#)|ORDER[-\s]*NO\.?\s*CUSTOMER|YOUR\s*ORDER/i],
  ['supplier_order', /ORDER[-\s]*NO\.?\s*KNOTT|SALES\s*ORDER|ORDER[-\s]*NO\.?/i],
  ['unit_price', /UNIT\s*PRICE|PRICE\s*PER\s*UNIT|EINZELPREIS|\bPRICE\b|\bRATE\b/i],
  ['amount', /\bAMOUNT\b|TOTAL\s*(VALUE|PRICE|AMOUNT)|\bVALUE\b|BETRAG|EXTENDED/i],
  ['country_of_origin', /COUNTRY\s*OF\s*ORIGIN|\bORIGIN\b|\bC\.?O\.?O\.?\b/i],
  ['marks', /MARKS\s*(&|AND)?\s*N(O|UMBER)S?\.?|SHIPPING\s*MARKS|\bMARKS\b/i],
  ['hs_code', /HS[-\s]*CODE|H\.S\.?\s*CODE|\bHTS(\s*CODE)?\b|TARIFF(\s*(CODE|NO\.?|NUMBER))?|ZOLLTARIF\S*|COMMODITY\s*CODE/i],
  ['part_number', /(RADEL\s*)?PART\s*(NO\.?|NUMBER|#)|ITEM[-\s]*NO\.?|ARTICLE(\s*NO\.?)?|ARTIKEL\S*|MATERIAL(\s*NO\.?)?|\bSKU\b|MODEL(\s*NO\.?)?/i],
  ['description', /DESCRIPTION(S)?(\s*OF\s*(THE\s*)?GOODS)?|GOODS\s*DESCRIPTION|BESCHREIBUNG|CONTENT\s*TYPE|\bPRODUCT\b/i],
  ['quantity', /QUANTITY(\s*SHIPPED)?|\bQTY\b|\bMENGE\b|\bPCS\b/i],
  ['unit', /\bUNIT\b(?!\s*PRICE)|\bUOM\b|\bMU\b|\bU\/M\b/i],
  ['net_kg', /NET\s*(W(T|EIGHT)?\.?)?\s*(\(KG\)|KG)?|NETTO|\bNET\b/i],
  ['gross_kg', /GROSS\s*(W(T|EIGHT)?\.?)?\s*(\(KG\)|KG)?(\s*INCLUDING\s*PALLET)?|BRUTTO(\s*KG)?/i],
  ['dimensions_cm', /DIMENSIONS?\s*(\(CM\))?|DIMS?\b(\s*L\s*X\s*W\s*X\s*H)?(\s*\(CM\))?|MASSE\s*(\(CM\))?|\bSIZE\b/i],
  ['volume_cbm', /\bCBM\b|\bVOLUME\b|\bM3\b|MEASUREMENT/i],
  ['forklift', /FORKLIFT(\s*REQUIRED)?/i],
  ['ship_date', /SCHEDULED|SHIP\s*DATE/i],
  ['package_id', /CARTON\s*NO\.?|CTN\s*NO\.?|PALLET\s*NO\.?|PACKAGE\s*(NO\.?|ID)|PKG\s*NO\.?|\bBOX\b|\bPACKAGE\b|\bCASE\s*NO\.?/i],
  ['line_no', /\bPOS(ITION)?\b\.?|\bLINE\s*(NO\.?|NUMBER)?\b|\bS\.?\s*NO\.?\b|\bSR\.?\s*NO\.?\b|\bITEM\b/i],
  ['weight_generic', /\bWEIGHT\b|^\(?KG\)?$/i],
];
const NUMERIC = new Set(['quantity', 'ordered_qty', 'net_kg', 'gross_kg', 'unit_price', 'amount', 'volume_cbm', 'package_count', 'pcs_per_package', 'package_weight', 'weight_generic']);
const ITEM_KEYS = ['description', 'part_number', 'customer_part_number'];
const PACKAGE_COLS = new Set(['package_id', 'package_type', 'package_count', 'dimensions_cm', 'gross_kg', 'volume_cbm', 'forklift', 'package_weight']);
const STOP_ROW = /^[^A-Za-z0-9]{0,2}I?(TOTAL|SUB\s*-?TOTAL|GESAMT|SUMME|SUMMARY|PACKAGING\s*DETAILS|NAME\s*:|SIGNATURE|FOR\s*AND\s*ON\s*BEHALF|SAY\s*TOTAL|FREIGHT\s*(COLLECT|PREPAID)|SHIPPED\s*ON\s*BOARD)\b/i;
const U = `(?:\\s*(?:CM|IN|["'′″]{1,2}))?`;
const DIMS_RE = new RegExp(`(\\d{1,4}(?:[.,]\\d+)?)${U}\\s*[xX×*]\\s*(\\d{1,4}(?:[.,]\\d+)?)${U}\\s*[xX×*]\\s*(\\d{1,4}(?:[.,]\\d+)?)\\s*(CM|MM|IN|["'′″]{1,2})?`, 'i');

// ---------------------------------------------------------------- tokens ----
interface Tok { text: string; x0: number; x1: number; conf: number }
/** Words of a line with x positions (proportional within a text run). */
function tokens(l: Line): Tok[] {
  const out: Tok[] = [];
  for (const s of l.segments) {
    const n = Math.max(s.text.length, 1), w = s.x1 - s.x0;
    for (const m of s.text.matchAll(/\S+/g)) out.push({ text: m[0], x0: s.x0 + (w * m.index!) / n, x1: s.x0 + (w * (m.index! + m[0].length)) / n, conf: s.conf });
  }
  return out;
}

// ---------------------------------------------------------------- header detection ----
interface Col { name: string; label: string; x0: number; x1: number }
function matchCols(l: Line): Col[] {
  const cols: (Col & { a: number; b: number; si: number })[] = [];
  l.segments.forEach((s: Segment, si) => {
    const n = Math.max(s.text.length, 1), w = s.x1 - s.x0;
    const taken: [number, number][] = [];
    for (const [name, re] of VOCAB) {
      for (const m of s.text.matchAll(new RegExp(re.source, 'gi'))) {
        if (!m[0].trim()) continue;
        const a = m.index!, b = a + m[0].length;
        if (taken.some(([x, y]) => a < y && b > x)) continue;
        taken.push([a, b]);
        cols.push({ name, label: m[0].trim(), x0: s.x0 + (w * a) / n, x1: s.x0 + (w * b) / n, a, b, si });
      }
    }
  });
  return cols.sort((p, q) => p.x0 - q.x0).map(({ name, label, x0, x1 }) => ({ name, label, x0, x1 }));
}
function classify(label: string): string | null {
  for (const [name, re] of VOCAB) if (re.test(label)) return name;
  return null;
}
const isDataLike = (l: Line) => /\d{3,}|\d[.,]\d/.test(l.text) && !/\(CM\)|\(KG\)/i.test(l.text);

/** A header (one or two stacked lines) starting at line i, or null. */
function headerAt(lines: Line[], i: number): { cols: Col[]; rows: number } | null {
  const l = lines[i];
  if (isDataLike(l) && !/\b(QTY|QUANTITY|DESCRIPTION)\b/i.test(l.text)) return null;
  let cols = matchCols(l);
  if (cols.length < 2) return null;
  let rows = 1;
  const nx = lines[i + 1];
  if (nx && nx.page === l.page && nx.y - l.y < 0.03 && !isDataLike(nx)) {
    // second header line: words under a first-line column extend its label; columns of their own are added
    const t2 = tokens(nx);
    if (t2.length && t2.length <= 12) {
      rows = 2;
      const under = new Map<Col, string[]>();
      const extra: Col[] = [];
      for (const c2 of matchCols(nx)) {
        const parents = cols.filter((c) => Math.min(c.x1, c2.x1 + 0.02) - Math.max(c.x0, c2.x0 - 0.02) > 0);
        // a parent spanning several sub-columns ("Weight" over "Net Gross") is replaced by them
        if (parents.length === 1 && (parents[0].name === 'weight_generic' || (classify(parents[0].label) !== null && /^(net_kg|gross_kg)$/.test(c2.name) && !/(net|gross)/.test(parents[0].name)))) { extra.push(c2); under.set(parents[0], ['__drop__']); }
        else if (!parents.length) extra.push(c2);
      }
      for (const t of t2) {
        const cx = (t.x0 + t.x1) / 2;
        const p = cols.find((c) => cx >= c.x0 - 0.02 && cx <= c.x1 + 0.02);
        if (p && under.get(p)?.[0] !== '__drop__') under.set(p, [...(under.get(p) ?? []), t.text]);
      }
      cols = cols.filter((c) => under.get(c)?.[0] !== '__drop__').map((c) => {
        const w = under.get(c);
        if (!w) return c;
        const label = `${c.label} ${w.join(' ')}`;
        return { ...c, label, name: classify(label) === 'line_no' && /QUANTITY/i.test(label) ? 'ordered_qty' : (classify(label) ?? c.name) };
      });
      // label pairs where the 2nd line decides the meaning
      cols = cols.map((c) => {
        if (/ORDER/i.test(c.label) && /CUSTOMER/i.test(c.label)) return { ...c, name: 'po_number' };
        if (/QUANTITY\s*SHIPPED|QUANTITY.*SHIPPED/i.test(c.label)) return { ...c, name: 'quantity' };
        if (/^LINE\s+NUMBER/i.test(c.label)) return { ...c, name: 'line_no' };
        return c;
      });
      cols.push(...extra);
      cols.sort((a, b) => a.x0 - b.x0);
    }
  }
  // a second column of the same kind: Box … Package -> id + type; Net kg (package) … Net kg (item) stay both
  const seen = new Set<string>();
  cols = cols.map((c) => {
    if (c.name === 'package_id' && seen.has('package_id')) return { ...c, name: 'package_type' };
    if (c.name === 'weight_generic') return { ...c, name: seen.has('gross_kg') ? 'net_kg' : 'gross_kg' };
    seen.add(c.name);
    return c;
  });
  // two "package type" columns (Knott: "Package / Type" + "Art des Packstücks"): the first holds the package number
  const pt = cols.filter((c) => c.name === 'package_type');
  if (pt.length > 1 && !cols.some((c) => c.name === 'package_id')) cols = cols.map((c) => (c === pt[0] ? { ...c, name: 'package_id' } : c));
  const names = new Set(cols.map((c) => c.name));
  const itemTable = ITEM_KEYS.some((k) => names.has(k)) && (names.has('quantity') || names.has('net_kg') || names.has('amount') || names.has('hs_code') || names.has('gross_kg'));
  const pkgTable = names.has('package_id') && (names.has('dimensions_cm') || names.has('gross_kg') || names.has('net_kg'));
  if (names.size < 3 || (!itemTable && !pkgTable)) return null;
  return { cols, rows };
}

// ---------------------------------------------------------------- value typing / scoring ----
interface Cell { text: string; conf: number; fit: number }
function typed(name: string, text: string, locale: Locale): { value: string | number; ok: boolean; extra?: Record<string, string | number> } {
  const t = text.trim();
  if (NUMERIC.has(name)) {
    const m = t.match(/-?\d[\d.,]*/);
    const p = m ? parseNumber(m[0], locale) : null;
    if (!p) return { value: t, ok: false };
    const unit = t.slice((m!.index ?? 0) + m![0].length).trim().replace(/^[.)]+/, '');
    const extra: Record<string, string> = {};
    if (name === 'package_count' && /[A-Z]{3,}/i.test(unit)) extra.package_type = normPkgType(unit);
    if (name === 'quantity' && /^[A-Z]{1,6}\.?$/i.test(unit) && !/^KGS?$/i.test(unit)) extra.unit = unit.toUpperCase().replace(/\.$/, '');
    return { value: p.value, ok: !p.ambiguous && (t.replace(/[\s]/g, '').length - m![0].length <= 8), extra };
  }
  if (name === 'hs_code') { const n = normHs(t.replace(/[^\d.]/g, '')); return n ? { value: n, ok: n.length % 2 === 0 } : { value: t, ok: false }; }
  if (name === 'dimensions_cm') { const d = dims(t); return d ? { value: d.v, ok: true, extra: d.inch ? { dimensions_in: d.v } : undefined } : { value: t, ok: false }; }
  if (name === 'country_of_origin') { const c = resolveCountry(t); return c ? { value: c, ok: true } : { value: t, ok: false }; }
  if (name === 'package_type') return /^[A-Z]{0,5}[-/]?\d{4,}$/i.test(t) ? { value: t, ok: true, extra: { package_id: t } } : { value: normPkgType(t), ok: true };
  if (name === 'package_id') { const m = t.match(/^(\S*\d\S*)\s+\S/); return m && m[1].length >= 5 ? { value: m[1], ok: false } : { value: t, ok: true }; } // "PACK0000600 No": OCR glued the next column on
  if (name === 'po_number') return { value: t, ok: /^45\d{8}$/.test(t) || /\d{4,}/.test(t) };
  return { value: t.replace(/\s{2,}/g, ' '), ok: t.length > 0 };
}
function dims(t: string): { v: string; inch: boolean } | null {
  const m = t.match(DIMS_RE);
  if (!m) return null;
  const n = (s: string) => String(Number(s.replace(',', '.')));
  const inch = /\d\s*(IN\b|["″])/i.test(m[0]);
  return { v: `${n(m[1])}x${n(m[2])}x${n(m[3])}`, inch };
}
function normPkgType(t: string): string {
  const u = t.toUpperCase().replace(/\s+/g, '');
  if (/PALLET|PALETTE|PLT/.test(u)) return 'PALLET';
  if (/CARTON|CTN|KARTON/.test(u)) return 'CARTON';
  if (/BOX/.test(u)) return 'BOX';
  if (/CRATE|KISTE/.test(u)) return 'CRATE';
  if (/PACKAGE|PKG|COLLI/.test(u)) return 'PACKAGE';
  return t.trim();
}
const r2 = (x: number) => Math.round(x * 100) / 100;

function finish(cells: Map<string, Cell>, locale: Locale, base: Partial<LineItem> = {}, cols_have_qty = false): LineItem {
  const it: LineItem = { ...base, scores: { ...(base.scores ?? {}) }, confidence: 1 };
  for (const [name, c] of cells) {
    if (['ship_date', 'weight_generic'].includes(name)) continue;
    if (name === 'volume_cbm' && /\d\s*KGS?\b/i.test(c.text)) { if (!cells.has('gross_kg')) { const g = typed('gross_kg', c.text, locale); if (g.ok) setV(it, 'gross_kg', g.value as number, r2(c.conf * c.fit * 0.8)); } continue; }
    // "2,00 Membranzylinder": a quantity that OCR glued to the description
    const q = name === 'description' && !cells.has('quantity') && cols_have_qty ? c.text.match(/^(\d[\d.,]*)\s+([A-Za-z].*)$/) : null;
    if (q) { const n = parseNumber(q[1], locale); if (n) { setV(it, 'quantity', n.value, r2(c.conf * 0.8)); setV(it, 'description', q[2], r2(c.conf * c.fit * 0.9)); continue; } }
    const t = typed(name, c.text, locale);
    // text that is not of the column's type: a dims string in any column is still a dimension
    const d = dims(c.text);
    if (!t.ok && d && name !== 'description') { setV(it, d.inch ? 'dimensions_in' : 'dimensions_cm', d.v, r2(c.conf * c.fit * 0.95)); continue; }
    // a number / HS code / dimension / country that does not parse is not output (it would be a guess)
    if (!t.ok && (typeof t.value !== 'number') && (NUMERIC.has(name) || ['hs_code', 'dimensions_cm', 'country_of_origin'].includes(name))) continue;
    const sc = r2(c.conf * c.fit * (t.ok ? 1 : 0.6));
    if (name === 'package_type' && t.extra?.package_id) { if (it.package_id == null) setV(it, 'package_id', t.value, sc); continue; } // an ID under a "Package type" caption
    if (name === 'dimensions_cm' && t.extra?.dimensions_in) setV(it, 'dimensions_in', t.value, sc);
    else setV(it, name, t.value, sc);
    for (const [k, v] of Object.entries(t.extra ?? {})) if (k !== 'dimensions_in' && it[k] == null) setV(it, k, v, sc);
  }
  return it;
}
function setV(it: LineItem, k: string, v: string | number, sc: number) {
  it[k] = v; it.scores[k] = sc;
  it.confidence = Math.min(it.confidence, sc);
}

// ---------------------------------------------------------------- A) tables ----
function tables(doc: Doc, locale: Locale, res: LineResult) {
  const L = doc.lines;
  for (let i = 0; i < L.length; i++) {
    const h = headerAt(L, i);
    if (!h) continue;
    const cols = h.cols;
    const names = new Set(cols.map((c) => c.name));
    const pkgTable = !ITEM_KEYS.some((k) => names.has(k));
    // the package column's label says what a package is ("Pallet No", "Carton No.", "Box")
    const idCol = cols.find((c) => c.name === 'package_id');
    const pkgIdCol = !!idCol;
    const pkgTypeHint = idCol && /PALLET|CARTON|CTN|BOX|CASE|CRATE/i.test(idCol.label) ? normPkgType(idCol.label) : (cols.some((c) => /PALLET/i.test(c.label)) ? 'PALLET' : null);
    const items: LineItem[] = []; const pkgs: LineItem[] = [];
    let cur: LineItem | null = null; let curPkg: LineItem | null = null; let lastY = L[i + h.rows - 1].y;
    let j = i + h.rows;
    let totals: Map<string, Cell> | null = null;
    for (; j < L.length; j++) {
      const l = L[j];
      if (l.page !== L[i].page || l.y - lastY > 0.14) break;
      if (headerAt(L, j)) break;
      if (STOP_ROW.test(l.text.trim()) || /^\W{0,2}TOTAL\b/i.test(tokens(l).map((t) => t.text).join(' '))) {
        if (/TOTAL|SUM|GESAMT/i.test(l.text)) {
          totals = assign(l, cols);
          // "Subtotal" with its numbers on the next line (Knott)
          if (![...totals.values()].some((c) => /\d/.test(c.text)) && L[j + 1] && L[j + 1].page === l.page) totals = assign(L[j + 1], cols);
        }
        break;
      }
      if (l.y > 0.95 || /@|WWW\.|HTTPS?:/i.test(l.text)) continue; // page footer
      if (items.length && l.segments.some((sg) => /^[:：]/.test(sg.text))) break; // "Packing  :Export Standard" footer block
      lastY = l.y;
      const cells = assign(l, cols);
      if (!cells.size) continue;
      if ((items.length || pkgs.length) && [...cells.values()].some((c) => /^\W{0,2}(SUB\s*-?)?TOTAL\b/i.test(c.text.trim()))) { totals = cells; break; }
      const has = (k: string) => cells.has(k) && /\S/.test(cells.get(k)!.text);
      const hasNum = ['quantity', 'net_kg', 'gross_kg', 'amount', 'unit_price'].some((k) => has(k) && /\d/.test(cells.get(k)!.text));
      const itemKey = ITEM_KEYS.some(has);
      if (items.length && !itemKey && !has('package_id') && !has('dimensions_cm') && !has('package_type') && !/\d+\s*[xX]\s*\d+\s*[xX]\s*\d+/.test(l.text) && hasNum && !pkgTable) { totals = cells; break; } // "105 PACKAGES 702.00 PCS 21,980.28 25,115.32" 
      const pkgOnly = [...cells.keys()].every((k) => PACKAGE_COLS.has(k) || k === 'po_number' || k === 'supplier_order' || k === 'net_kg' || k === 'marks');
      if (pkgTable || (!itemKey && pkgOnly && (has('package_id') || has('dimensions_cm') || has('gross_kg')) && !has('quantity'))) {
        const p = finish(cells, locale, { page: l.page, source: 'table' });
        if (p.package_id == null && p.dimensions_cm == null && p.gross_kg == null && p.net_kg == null) continue;
        if (p.po_number != null) { p.po_ref = p.po_number; delete p.po_number; delete p.scores.po_number; } // applies to the items below
        delete p.supplier_order; delete p.scores.supplier_order;
        if (p.package_count != null) { p.count = p.package_count; p.scores.count = p.scores.package_count; delete p.package_count; delete p.scores.package_count; }
        if (p.package_type == null && pkgTypeHint) setV(p, 'package_type', pkgTypeHint, 0.9);
        // the package table of a list (Radel) repeats the id of an earlier row: merge
        let same = p.package_id != null ? [...res.packages, ...pkgs].find((x) => x.package_id === p.package_id) : undefined;
        if (!same && p.package_id != null && l.segments.some((sg) => sg.conf < 1)) {
          const near = [...res.packages, ...pkgs, ...items.map((x) => ({ package_id: x.package_id ?? x.package_ref, scores: {}, confidence: 1 }) as LineItem)].filter((x) => x.package_id != null && lev(String(x.package_id), String(p.package_id)) <= 2);
          const ids = [...new Set(near.map((x) => String(x.package_id)))];
          if (ids.length === 1) { p.package_id = ids[0]; p.scores.package_id = Math.min(p.scores.package_id, 0.7); same = [...res.packages, ...pkgs].find((x) => x.package_id === ids[0]); }
        }
        if (same) { for (const [k, v] of Object.entries(p)) if (k !== 'scores' && k !== 'confidence' && same[k] == null) { same[k] = v; same.scores[k] = p.scores[k]; } }
        else pkgs.push(p);
        curPkg = same ?? p;
        continue;
      }
      if (itemKey && (hasNum || has('hs_code') || (has('part_number') && has('description')))) {
        const it = finish(cells, locale, { page: l.page, source: 'table' }, names.has('quantity'));
        const mv = (to: LineItem, k: string, as = k) => { if (it[k] != null) { if (to[as] == null) setV(to, as, it[k], it.scores[k]); delete it[k]; delete it.scores[k]; } };
        if (it.package_count != null) {
          // "15 PALLETS" on an item row: the row lists its packages; weights stay on the item (one row = one lot)
          const p: LineItem = { page: l.page, source: 'table', scores: {}, confidence: 1 };
          mv(p, 'package_count', 'count'); mv(p, 'package_type');
          const cl = cols.find((c) => c.name === 'package_count')?.label ?? '';
          const kind = /CTN|CARTON|BOX|PALLET|CASE/i.test(cl) ? normPkgType(cl) : pkgTypeHint;
          if (p.package_type == null && kind) setV(p, 'package_type', kind, 0.9);
          pkgs.push(p);
        } else if (it.package_id != null || (curPkg && pkgIdCol)) {
          // carton / box rows: gross, dims and CBM printed on a row are the carton's, not the item's
          if (it.package_id != null) {
            const same = pkgs.find((x) => x.package_id === it.package_id) ?? res.packages.find((x) => x.package_id === it.package_id);
            if (same) curPkg = same;
            else if (it.gross_kg != null || it.dimensions_cm != null || it.volume_cbm != null || !pkgIdCol || pkgTypeHint) {
              curPkg = { page: l.page, source: 'table', scores: {}, confidence: 1 };
              setV(curPkg, 'package_id', it.package_id, it.scores.package_id);
              if (pkgTypeHint) setV(curPkg, 'package_type', pkgTypeHint, 0.9);
              pkgs.push(curPkg);
            } else curPkg = null;
          }
          if (curPkg) for (const k of ['dimensions_cm', 'gross_kg', 'volume_cbm', 'package_type']) mv(curPkg, k);
        }
        if (curPkg?.package_id != null && it.package_id == null) it.package_ref = curPkg.package_id;
        if (curPkg?.po_ref != null && it.po_number == null) it.po_ref = curPkg.po_ref;
        items.push(it); cur = it;
        continue;
      }
      // continuation: wrapped description, a part number under the previous row, ...
      if (cur) {
        for (const [k, c] of cells) {
          if (k === 'description') { cur.description = `${cur.description ?? ''} ${c.text}`.trim(); cur.scores.description = Math.min(cur.scores.description ?? 1, r2(c.conf * c.fit)); }
          else if (cur[k] == null && !NUMERIC.has(k)) { const f = finish(new Map([[k, c]]), locale); if (f[k] != null) setV(cur, k, f[k] as any, Math.min(f.scores[k], 0.9)); }
        }
      }
    }
    consensus(items, L[i]); consensus(pkgs, L[i]);
    for (const p of pkgs) if (p.package_count != null && p.count == null) { p.count = p.package_count; p.scores.count = p.scores.package_count; delete p.package_count; delete p.scores.package_count; }
    res.lineItems.push(...items); res.packages.push(...pkgs);
    if (totals && (items.length || pkgs.length)) {
      const T = finish(totals, locale);
      // each total is checked against the rows that carry that column (item net, package gross, …)
      const iT = { ...T, scores: {} } as LineItem, pT = { ...T, scores: {} } as LineItem;
      for (const k of ['quantity', 'net_kg', 'gross_kg', 'volume_cbm', 'amount']) {
        const onItems = items.some((x) => typeof x[k] === 'number'), onPkgs = pkgs.some((x) => typeof x[k] === 'number');
        if (!onItems) delete iT[k];
        if (!onPkgs || onItems && k !== 'gross_kg' && k !== 'net_kg') delete pT[k];
      }
      if (items.length) reconcile(items, iT, res, 'items');
      if (pkgs.length) reconcile(pkgs, pT, res, 'packages');
    }
    sanity([...items, ...pkgs], res);
    // packages and their items both list net weight: the two sums must agree (catches a shifted OCR column)
    const sumOf = (rs: LineItem[], k: string) => rs.reduce((a, x) => a + (typeof x[k] === 'number' ? x[k] : 0), 0);
    if (items.length && pkgs.length && items.every((x) => typeof x.net_kg === 'number') && pkgs.every((x) => typeof x.net_kg === 'number')) {
      const a = sumOf(items, 'net_kg'), b = sumOf(pkgs, 'net_kg');
      const ok = Math.abs(a - b) <= Math.max(0.011, a * 0.002);
      res.checks.push({ check: 'packages: Σ net = Σ item net', status: ok ? 'pass' : 'fail', detail: `packages ${r2(b)} vs items ${r2(a)}` });
      if (!ok) for (const x of pkgs) { x.scores.net_kg = Math.min(x.scores.net_kg, 0.6); }
    }
    if (items.length || pkgs.length) i = j - 1;
  }
}

/** Does text fit a column's type? (used to break ties between neighbouring columns) */
function fitsType(name: string, text: string): boolean {
  if (name === 'volume_cbm' && /KGS?\b|LBS?\b/i.test(text)) return false;
  if (/^(gross_kg|net_kg)$/.test(name) && /\b(CBM|M3)\b/i.test(text)) return false;
  if (NUMERIC.has(name)) return /^\D{0,2}\d/.test(text.trim());
  if (name === 'hs_code') return /^\d{4}\.?\d{2}/.test(text.trim());
  if (name === 'dimensions_cm') return !!dims(text);
  if (name === 'description') return /[A-Za-z]{3}/.test(text);
  return true;
}
const NA = /^(N\/?A|-+|–|NIL|NONE)$/i;

/**
 * A line -> header columns. A text run stays whole and goes to the column it overlaps most (or the nearest one that
 * fits its type). Only a run that spans two or more header columns ("GZP238729 1 Ew Palette klein") is split into words.
 */
function assign(l: Line, cols: Col[]): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  const put = (c: Col, text: string, conf: number, fit: number) => {
    if (NA.test(text.trim())) return;
    const prev = cells.get(c.name);
    cells.set(c.name, prev ? { text: `${prev.text} ${text}`, conf: Math.min(prev.conf, conf), fit: Math.min(prev.fit, fit) } : { text, conf, fit });
  };
  const nearest = (x0: number, x1: number, text: string): [Col | null, number] => {
    let best: Col | null = null; let bd = Infinity;
    for (const c of cols) {
      const ov = Math.min(x1, c.x1) - Math.max(x0, c.x0);
      let d = ov > 0 ? -ov : Math.max(c.x0 - x1, x0 - c.x1);
      if (!fitsType(c.name, text)) d += 0.06;
      if (d < bd) { bd = d; best = c; }
    }
    return [best, bd];
  };
  for (const s of l.segments) {
    const spanned = cols.filter((c) => Math.min(s.x1, c.x1) - Math.max(s.x0, c.x0) > Math.min(0.4 * (c.x1 - c.x0), 0.02));
    if (spanned.length >= 2 && /\s/.test(s.text)) {
      for (const t of tokens({ ...l, segments: [s] })) {
        const [c, d] = nearest(t.x0, t.x1, t.text);
        if (c && d <= 0.1) put(c, t.text, t.conf, s.conf < 1 ? 0.85 : d <= 0 ? 0.95 : 0.85); // split by estimated word position (OCR spacing is unreliable)
      }
      continue;
    }
    const [c, d] = nearest(s.x0, s.x1, s.text);
    if (!c || d > 0.12) continue;
    put(c, s.text, s.conf, spanned.length >= 2 ? 0.7 : d <= 0 ? 1 : d < 0.05 ? 0.93 : 0.8); // merged across columns -> check
  }
  return cells;
}

// ---------------------------------------------------------------- B) label blocks ----
const TARIFF = String.raw`(?:CUSTOMS\s*)?T\s*A\s*R\s*[I1L]?\s*F\s*F?\s*-?\s*N\s*(?:U\s*M\s*B\s*E\s*)?R|HS\s*CODE`;
const BLOCK_LABELS = new RegExp(String.raw`COUNTRY\s*OF\s*ORIGIN\s*:|${TARIFF}|PO-?\s*LINE\s*:`, 'i');
const OCR_DIGIT: Record<string, string> = { A: '4', O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
function blocks(doc: Doc, locale: Locale, res: LineResult) {
  const L = doc.lines;
  if (!L.some((l) => /COUNTRY\s*OF\s*ORIGIN\s*:/i.test(l.text) && L.some((x) => new RegExp(TARIFF, 'i').test(x.text) && /\d{8}/.test(x.text)))) return;
  const items: LineItem[] = [];
  for (let i = 0; i < L.length; i++) {
    const segs = L[i].segments;
    // item start: short position number at the left, an article number, the quantity at the far right
    const m = segs[0]?.text.match(/^([0-9AOISBZG]{1,3})\s+(\S{5,})$/) ?? (segs[0] && /^[0-9AOISBZG]{1,3}$/.test(segs[0].text) && segs[1] && /^\S{5,}$/.test(segs[1].text) ? [segs[0].text + ' ' + segs[1].text, segs[0].text, segs[1].text]
      : segs[0] && /^\S{5,}$/.test(segs[0].text) && segs[0].x0 > 0.1 && L.slice(i + 1, i + 4).some((x) => /COUNTRY\s*OF\s*ORIGIN/i.test(x.text)) ? [segs[0].text, '', segs[0].text] : null);
    const last = segs[segs.length - 1];
    if (!m || segs.length < 2 || !last || last.x0 < 0.7 || !/^\d[\d.,]*$/.test(last.text) || segs[0].x0 > 0.15) continue;
    if (!/\d{3,}/.test(m[2]) || /^(PAGE|TOTAL)/i.test(m[2])) continue;
    const posRaw = m[1];
    const pos = posRaw.split('').map((ch) => OCR_DIGIT[ch] ?? ch).join('');
    const conf = Math.min(...segs.map((s) => s.conf));
    const it: LineItem = { page: L[i].page, source: 'block', scores: {}, confidence: 1 };
    if (pos) setV(it, 'line_no', pos, r2(conf * (pos === posRaw ? 1 : 0.7)));
    setV(it, 'part_number', m[2].replace(/O$/, '0'), r2(conf));
    const q = parseNumber(last.text, locale);
    if (q) setV(it, 'quantity', q.value, r2(last.conf * (q.ambiguous ? 0.85 : 1)));
    for (let k = i + 1; k < Math.min(L.length, i + 6); k++) {
      const l = L[k];
      if (l.page !== L[i].page) break;
      const s0 = l.segments[0];
      if (/^[0-9AOISBZG]{1,3}$/.test(s0?.text ?? '') || /^[0-9AOISBZG]{1,3}\s+\S{5,}$/.test(s0?.text ?? '') && l.segments.length >= 2 && l.segments[l.segments.length - 1].x0 > 0.7) break;
      if (/^(TOTAL|SUBTOTAL|BALANCE)/i.test(l.text.trim())) break;
      const lc = Math.min(...l.segments.map((s) => s.conf));
      const coIdx = l.segments.findIndex((s) => /COUNTRY\s*OF\s*ORIGIN/i.test(s.text));
      if (coIdx >= 0) {
        const own = l.segments[coIdx].text.replace(/.*COUNTRY\s*OF\s*ORIGIN\s*:?\s*/i, '');
        const txt = own || l.segments[coIdx + 1]?.text || '';
        const c = resolveCountry(txt.replace(/PO-?\s*LINE.*$/i, ''));
        if (c) setV(it, 'country_of_origin', c, r2(lc)); else if (txt) setV(it, 'country_of_origin', txt, r2(lc * 0.6));
      }
      const pl = l.text.match(/PO-?\s*LINE\s*:?\s*(\d+)/i);
      if (pl) setV(it, 'po_line', pl[1], r2(lc));
      const hs = l.text.match(new RegExp(`(${TARIFF})[^\\d\\n]{0,4}(\\d[\\d.]{5,12})`, 'i'));
      if (hs) { const n = normHs(hs[2]); if (n) setV(it, 'hs_code', n, r2(lc * (n.length % 2 ? 0.6 : 1))); } // HS = 6, 8 or 10 digits
      if (coIdx < 0 && !pl && !hs && !new RegExp(TARIFF, 'i').test(l.text) && it.description == null && k <= i + 2 && /[A-Za-z]/.test(l.text)) setV(it, 'description', l.text.replace(/\s{2,}/g, ' ').trim(), r2(lc * 0.95));
    }
    items.push(it);
  }
  if (!items.length) return;
  res.lineItems.push(...items);
  // printed total quantity
  const tq = L.find((l) => /^\W?TOTAL\s*QTY/i.test(l.text.trim()));
  const tv = tq ? parseNumber(tq.segments[tq.segments.length - 1].text, locale) : null;
  if (tv) reconcile(items, { quantity: tv.value, scores: {}, confidence: 1 } as LineItem, res, 'block');
}

// ---------------------------------------------------------------- C) packages from free text ----
function freePackages(doc: Doc, locale: Locale, res: LineResult) {
  const L = doc.lines;
  const text = (i: number) => L[i].text;
  for (let i = 0; i < L.length; i++) {
    const t = text(i);
    // "Total colli: 4 pallets: 120x80x137cm - 690kg; 120x80x69cm - 280kg ..." (may wrap to the next line)
    if (/COLL\w*\s*:|PALLETS?\s*:/i.test(t) && DIMS_RE.test(t + ' ' + (L[i + 1]?.text ?? ''))) {
      const all = t + ' ' + (L[i + 1] && !/^(CTT|[A-Z][a-z]+\s*-)/.test(L[i + 1].text) ? L[i + 1].text : '');
      const conf = Math.min(...L[i].segments.map((s) => s.conf));
      const type = /PALLET/i.test(all) ? 'PALLET' : /CARTON|CTN/i.test(all) ? 'CARTON' : /BOX/i.test(all) ? 'BOX' : 'PACKAGE';
      const found: LineItem[] = [];
      for (const m of all.matchAll(/(?:\b(\d{1,2})\s*x\s+)?(\d{2,3}\s*x\s*\d{2,3}\s*x\s*\d{2,3})\s*(?:cm)?\s*(?:[-–:;]\s*)?(?:gross\s*weight\s*:?\s*)?(?:(\d[\d.,]*)\s*kg)?/gi)) {
        const p: LineItem = { page: L[i].page, source: 'text', scores: {}, confidence: 1 };
        setV(p, 'package_type', type, r2(conf * 0.95));
        setV(p, 'count', m[1] ? Number(m[1]) : 1, r2(conf * (m[1] ? 0.95 : 0.9))); // each listed size is one package
        setV(p, 'dimensions_cm', dims(m[2])!.v, r2(conf * 0.95));
        if (m[3]) { const w = parseNumber(m[3], locale); if (w) setV(p, 'gross_kg', w.value, r2(conf * 0.95)); }
        found.push(p);
      }
      const colli = all.match(/COLL\w*\s*:?\s*(\d+)\s*(PALLETS?|CARTONS?|BOX(ES)?|PACKAGES?)/i);
      const tg = all.match(/TOTAL\s*GROSS\s*WEIGHT\s*:?\s*(\d[\d.,]*)\s*kg/i);
      // one package and only a total weight printed: that weight is the package's
      if (found.length === 1 && found[0].gross_kg == null && tg) { const w = parseNumber(tg[1], locale); if (w) setV(found[0], 'gross_kg', w.value, r2(conf * 0.9)); }
      if (!found.length) { /* not a colli list: try the pallet-size rules below */ }
      else {
        res.packages.push(...found);
        if (colli) res.checks.push({ check: 'packages: count stated vs listed', status: Number(colli[1]) === found.reduce((s, p) => s + Number(p.count ?? 1), 0) ? 'pass' : 'fail', detail: `${colli[1]} stated, ${found.length} listed` });
        if (tg) { const w = parseNumber(tg[1], locale)?.value; const s = found.reduce((a, p) => a + Number(p.gross_kg ?? 0), 0); if (w && found.every((p) => p.gross_kg != null)) res.checks.push({ check: 'packages: Σ gross = total gross', status: Math.abs(s - w) <= 0.5 ? 'pass' : 'fail', detail: `Σ ${s} vs ${w}` }); }
      }
      if (found.length) { i++; continue; }
    }
    // "Pallet Size  120 cm x 80cm x 70cm"  /  "3 pallets: Each Pallets Dimensions: 48"x40'x55". Weight: 236lb. each pallet."
    if (/PALLET\s*SIZE|PALLETS?\s*DIMENSIONS?|CARTON\s*SIZE|BOX\s*SIZE/i.test(t) || (/^\s*\d+\s*PALLETS?\s*:?\s*$/i.test(t) && L[i + 1] && /DIMENSION/i.test(L[i + 1].text))) {
      const win = L.slice(i, i + 4).filter((l) => l.page === L[i].page);
      const joined = win.map((l) => l.text).join('  ');
      const d = dims(joined.replace(/[´`’]/g, "'"));
      if (!d) continue;
      const conf = Math.min(...win.flatMap((l) => l.segments.map((s) => s.conf)));
      const noDims = res.packages.filter((p) => p.dimensions_cm == null && p.dimensions_in == null);
      const pal = noDims.filter((p) => p.package_type === 'PALLET');
      const pkgsExisting = /PALLET/i.test(joined) && pal.length ? pal : noDims;
      const n = joined.match(/^\s*(\d+)\s*PALLETS?/i);
      const target: LineItem = pkgsExisting.length === 1 ? pkgsExisting[0] : { page: L[i].page, source: 'text', scores: {}, confidence: 1 };
      if (target !== pkgsExisting[0]) { setV(target, 'package_type', 'PALLET', r2(conf * 0.9)); if (n) setV(target, 'count', Number(n[1]), r2(conf * 0.9)); res.packages.push(target); }
      setV(target, d.inch ? 'dimensions_in' : 'dimensions_cm', d.v, r2(conf * 0.9));
      const lb = joined.match(/WEIGHT\s*:?\s*(\d[\d.,]*)\s*(LB|IB|LBS)\b\.?\s*(EACH)?/i);
      if (lb && target.gross_kg == null) setV(target, 'gross_lb', Number(lb[1].replace(',', '.')), r2(conf * 0.85));
      i += win.length - 1;
    }
  }
}

// ---------------------------------------------------------------- D) BL containers ----
function containers(doc: Doc, locale: Locale, res: LineResult) {
  const seen = new Set<string>();
  for (const l of doc.lines) {
    const t = l.text.replace(/\s+/g, ' ');
    const conf = Math.min(...l.segments.map((s) => s.conf));
    const add = (c: LineItem) => { if (!seen.has(String(c.container_number))) { seen.add(String(c.container_number)); res.containers.push(c); } };
    // 40HD/CMAU6525747/R5401959/CY/CY/53PACKAGE(S)/12562.520KGS/22.0000CBM
    for (const m of t.matchAll(/\b(\d{2}\s?(?:HD|HC|HQ|GP|DV|RF|OT|FR|DC|ST))\s*\/\s*([A-Z]{4}\s?\d{6,7})\s*\/\s*([A-Z0-9-]{4,15})?[^\n]*?\/\s*(\d+)\s*(?:PACKAGES?|PKGS?|PALLETS?|CTNS?|PACKAGE\(S\))\S*\s*\/\s*(\d[\d.,]*)\s*KGS?\s*\/\s*(\d[\d.,]*)\s*CBM/gi)) {
      const num = m[2].replace(/\s/g, '');
      const c: LineItem = { page: l.page, source: 'bl', scores: {}, confidence: 1 };
      const ok = validContainer(num);
      setV(c, 'container_number', num, r2(conf * (ok ? 1 : 0.6)));
      setV(c, 'container_type', m[1].replace(/\s/g, '').toUpperCase(), r2(conf));
      if (m[3]) setV(c, 'seal_number', m[3], r2(conf * 0.95));
      setV(c, 'packages', Number(m[4]), r2(conf));
      const w = parseNumber(m[5], 'us'); if (w) setV(c, 'gross_kg', w.value, r2(conf));
      const v = parseNumber(m[6], 'us'); if (v) setV(c, 'volume_cbm', v.value, r2(conf));
      add(c);
    }
    // Container: MSDU 135046-7 (20 DV) Seal: FX40803304
    const m2 = t.match(/CONTAINER\s*:?\s*([A-Z]{4})\s?(\d{6})\s*-?\s*(\d)\s*\(?\s*(\d{2})\s*'?\s*(DV|GP|HC|HQ|RF|OT|HD)?\s*\)?\s*(?:SEAL\s*:?\s*([A-Z0-9-]{4,15}))?/i);
    if (m2) {
      const num = `${m2[1]}${m2[2]}${m2[3]}`.toUpperCase();
      const c: LineItem = { page: l.page, source: 'bl', scores: {}, confidence: 1 };
      setV(c, 'container_number', num, r2(conf * (validContainer(num) ? 1 : 0.6)));
      if (m2[5]) setV(c, 'container_type', `${m2[4]}${m2[5]}`.toUpperCase(), r2(conf));
      if (m2[6]) setV(c, 'seal_number', m2[6], r2(conf));
      add(c);
    }
    // any other line holding a valid container number: type, seal, packages, kg and CBM on the same line
    for (const m of t.matchAll(/\b([A-Z]{4})\s?(\d{6})\s*-?\s*(\d)\b/g)) {
      const num = `${m[1]}${m[2]}${m[3]}`;
      if (seen.has(num) || !validContainer(num)) continue;
      const rest = t.slice(m.index! + m[0].length, m.index! + m[0].length + 160).split(/\b[A-Z]{4}\s?\d{6}\s*-?\s*\d\b/)[0];
      const c: LineItem = { page: l.page, source: 'bl', scores: {}, confidence: 1 };
      setV(c, 'container_number', num, r2(conf));
      const ty = rest.match(/\b(20|40|45)\s*'?\s*(HC|HQ|GP|DV|RF|OT|HD|DC|ST)\b/i); if (ty) setV(c, 'container_type', `${ty[1]}${ty[2]}`.toUpperCase(), r2(conf));
      const se = rest.match(/SEAL\s*(?:NO\.?|#)?\s*:?\s*([A-Z0-9][A-Z0-9-]{4,15})/i); if (se) setV(c, 'seal_number', se[1], r2(conf));
      const pk = rest.match(new RegExp(`(\\d{1,5})\\s*(${PKG_KIND})`, 'i')); if (pk) setV(c, 'packages', Number(pk[1]), r2(conf));
      const kg = rest.match(/(\d[\d.,]*)\s*KGS?\b/i); if (kg) { const w = parseNumber(kg[1], locale); if (w) setV(c, 'gross_kg', w.value, r2(conf * (w.ambiguous ? 0.85 : 1))); }
      const cb = rest.match(/(\d[\d.,]*)\s*(CBM|M3)\b/i); if (cb) { const v = parseNumber(cb[1], locale); if (v) setV(c, 'volume_cbm', v.value, r2(conf * (v.ambiguous ? 0.85 : 1))); }
      if (Object.keys(c.scores).length > 1) add(c); // a bare number in the marks is handled below
    }
    // 1/40'HC CONTAINER  +  a container number anywhere on the BL face
    const m3 = t.match(/\b(\d+)\s*\/\s*(\d{2})\s*'?\s*(HC|HQ|GP|DV|RF|OT|HD)\s*CONTAINER/i);
    if (m3 && !res.containers.length) {
      const cn = doc.text.match(/\b([A-Z]{4}\d{7})\b/);
      if (cn && validContainer(cn[1])) {
        const c: LineItem = { page: l.page, source: 'bl', scores: {}, confidence: 1 };
        setV(c, 'container_number', cn[1], r2(conf * 0.95));
        setV(c, 'container_type', `${m3[2]}${m3[3]}`.toUpperCase(), r2(conf));
        add(c);
      }
    }
  }
}

/**
 * BL goods: the cargo block under "Marks / Number and kind of packages / Description of goods / Weight / Measurement".
 * When the face says "as per attachment" / "see attached rider", the block on the attached page is used instead.
 * A line that starts with "<n> <package kind>" starts a new goods item ("104 PALLETS RUN FLAT …", "1 BOX PAD PEDAL …").
 */
const PKG_KIND = String.raw`PKGS?|PACKAGES?(?:\s*\(\s*S\s*\)?)?|PACKAGE\(|PALLETS?|PLTS?|CTNS?|CARTONS?|BOX(?:ES)?|CASES?|CRATES?|BUNDLES?|DRUMS?|BAGS?|ROLLS?|UNITS?`;
const GOODS_HDR = /DESCRIPTIONS?\s*OF\s*(THE\s*)?(GOODS|PACKAGES)|DESCRIPTIONOFPACKAGES|KIND\s*OF\s*PACKAGES|MARKS\s*AND\s*N(UMBER|O)S?/i;
const GOODS_STOP = /CONTAINER\s*(\/|NO\b|NUMBERS?\s*\/)|FREIGHT\s*(COLLECT|PREPAID)|SHIPPED\s*ON\s*BOARD|CERTIFIED\s*LOADED|PARTICULARS\s*FURNISHED|CONTRACTUAL\s*CLAUSES|CONTAINER\s*TYPE|PLACE\s*AND\s*DATE|^TOTAL\b|ABOVE\s*PARTICULARS|TO\s*BE\s*CONTINUED/i;
const GOODS_SKIP = /^(SAID\s*TO\s*CONTAIN|S\.?T\.?C\.?|SHIPPER'?S?\s*LOAD|STOWAGE|AS\s*PER\s*ATTACH|NET\s*WEIGHT|SRN\b|PON?\b|INV\b|EXPRESS\s*B\/?L|\d+\s*\/\s*\d{2}\s*'?\s*(HC|HQ|GP|DV|HD)|ONE|TWO|THREE|\(?\d+\)?\s*X?\s*\d{2}'?\s*(HC|HQ|GP|DV|HD))|^[\d,\s]+$|CONTAINER\s*ONLY|^\d+\s*PCS$|^\(?KGS?\)?$|^\(?CBM\)?$|^KGS?$|^CBM$|^M3$/i;
function goodsBlock(L: Line[], hi: number, locale: Locale) {
  const hdr = L[hi];
  const descX = Math.min(...hdr.segments.filter((s) => /KIND|PACKAGES|DESCRIPTION|NUMBER\s*AND/i.test(s.text)).map((s) => s.x0), 0.6);
  const rightX = Math.max(0.6, ...hdr.segments.filter((s) => /GROSS|WEIGHT/i.test(s.text)).map((s) => s.x0 - 0.03));
  const items: LineItem[] = []; const marks: string[] = []; const rest: string[] = [];
  let cur: LineItem | null = null; let attach = false; let lastY = hdr.y; let conf = 1; let nums: number[] = []; const rawNums: string[] = []; const pos: string[] = [];
  for (let k = hi + 1; k < L.length; k++) {
    const l = L[k];
    if (l.page !== hdr.page || l.y - lastY > 0.09 || GOODS_STOP.test(l.text.trim())) break;
    if (l.y - hdr.y < 0.022 && (GOODS_HDR.test(l.text) || /^\(?(KGS?|CBM|WEIGHT|MEASUREMENT|TYPES?\s*OF)/i.test(l.text.trim()) || /MEASUREMENT|WEIGHT\s*\(/i.test(l.text))) continue; // header 2nd line
    if (/NET\s*WEIGHT/i.test(l.text)) continue;
    lastY = l.y;
    if (/ATTACH|RIDER/i.test(l.text)) attach = true;
    const segs: Segment[] = [];
    for (const sg of l.segments) {
      const prev = segs[segs.length - 1];
      if (prev && /^\d{1,5}$/.test(prev.text.trim()) && new RegExp(`^(${PKG_KIND})`, 'i').test(sg.text.trim()) && sg.x0 - prev.x1 < 0.06) segs[segs.length - 1] = { ...prev, text: `${prev.text} ${sg.text}`, x1: sg.x1, conf: Math.min(prev.conf, sg.conf) };
      else segs.push(sg);
    }
    for (const sg of segs) {
      const tx = sg.text.trim();
      conf = Math.min(conf, sg.conf);
      if (sg.x1 <= descX + 0.01) { if (!new RegExp(`^\\d+\\s*(${PKG_KIND})`, 'i').test(tx) && !/^S\)$/.test(tx)) marks.push(tx); continue; }
      if (sg.x0 >= rightX) { for (const m of tx.matchAll(/(\d[\d.,]*)/g)) { rawNums.push(m[1]); const p = parseNumber(m[1], locale); if (p) nums.push(p.value); } continue; }
      const po = tx.match(/^PO\s*(?:NO\.?|#)?\s*[:：]?\s*([A-Z0-9][A-Z0-9-]{4,})$/i);
      if (po) { pos.push(po[1]); continue; }
      const hs = tx.match(/HS\s*CODE\s*:?\s*([\d.]{6,13})/i);
      if (hs) { if (cur) { const n = normHs(hs[1]); if (n) setV(cur, 'hs_code', n, r2(sg.conf * 0.95)); } continue; }
      const w = tx.match(/(\d[\d.,]*)\s*KGS?\b/i), v = tx.match(/(\d[\d.,]*)\s*(CBM|M3)\b/i);
      const start = tx.match(new RegExp(`^(\\d{1,5})\\s*(${PKG_KIND})\\s*(.*)$`, 'i'));
      if (start) {
        cur = { page: l.page, source: 'bl', scores: {}, confidence: 1 };
        setV(cur, 'quantity', Number(start[1]), r2(sg.conf * 0.95));
        setV(cur, 'unit', start[2].toUpperCase().replace(/\(\s*S?\s*\)?$|\($/, '').trim(), r2(sg.conf * 0.95));
        items.push(cur);
        const d = start[3].replace(/\b(STC|S\.T\.C\.?)\b/i, '').replace(/[:=]\s*\d+\s*PCS.*$/i, '').replace(/\s*:\s*$/, '').trim();
        if (d && !GOODS_SKIP.test(d)) setV(cur, 'description', d, r2(sg.conf * 0.9));
        continue;
      }
      if (w && cur && cur.gross_kg == null) { const p = parseNumber(w[1], locale); if (p) setV(cur, 'gross_kg', p.value, r2(sg.conf * 0.9)); }
      if (v && cur && cur.volume_cbm == null) { const p = parseNumber(v[1], locale); if (p) setV(cur, 'volume_cbm', p.value, r2(sg.conf * 0.9)); }
      const t2 = tx.replace(/(\d[\d.,]*)\s*KGS?\b|(\d[\d.,]*)\s*(CBM|M3)\b/gi, '').trim();
      if (!t2 || GOODS_SKIP.test(t2) || /ATTACH|RIDER/i.test(t2) || !/[A-Za-z]{2}/.test(t2)) continue;
      if (t2.replace(/\D/g, '').length > 0.5 * t2.replace(/\s/g, '').length) continue; // PO / invoice number lists
      if (cur) cur.description = cur.description ? `${cur.description} ${t2}` : t2, cur.scores.description = Math.min(cur.scores.description ?? 1, r2(sg.conf * 0.9));
      else rest.push(t2);
    }
  }
  if (!items.length && rest.length) { const it: LineItem = { page: hdr.page, source: 'bl', scores: {}, confidence: 1 }; setV(it, 'description', rest.join(' '), r2(conf * 0.85)); items.push(it); }
  // weight / measurement columns: one goods item -> its values (the first two numbers: kg, cbm)
  if (rawNums.some((x) => /^0,\d+$|,\d{1,2}$/.test(x))) nums = rawNums.map((x) => parseNumber(x, 'eu')?.value ?? NaN).filter((x) => Number.isFinite(x));
  if (items.length === 1 && nums.length) {
    if (items[0].gross_kg == null) setV(items[0], 'gross_kg', nums[0], r2(conf * 0.9));
    if (nums.length > 1 && items[0].volume_cbm == null) setV(items[0], 'volume_cbm', nums[1], r2(conf * 0.9));
  }
  if (items.length === 1 && pos.length === 1 && items[0].po_number == null) setV(items[0], 'po_number', pos[0], r2(conf * 0.9));
  const mk = marks.filter((m) => !/^\d{1,3}$/.test(m)).join(' ').replace(/-\s+/g, '-').trim();
  if (mk && items.length === 1) {
    setV(items[0], 'marks', mk, r2(conf * 0.9));
    const po = mk.match(/\bPON?\s*:?\s*(45\d{8})\b/i);
    if (po) setV(items[0], 'po_number', po[1], r2(conf * 0.95));
  }
  return { items, attach };
}
function blGoods(doc: Doc, f: Record<string, { value: any; confidence: number }>, res: LineResult, locale: Locale) {
  const L = doc.lines;
  const heads = L.map((l, i) => (GOODS_HDR.test(l.text) && l.segments.length >= 2 ? i : -1)).filter((i) => i >= 0);
  if (!heads.length) return;
  let best = goodsBlock(L, heads[0], locale);
  // face says "as per attachment": the attached page's block replaces it (same page heads are the same block)
  for (const h of heads.slice(1)) {
    if (!best.attach && best.items.length && best.items.some((x) => x.description)) break;
    if (L[h].page === L[heads[0]].page) continue;
    const nb = goodsBlock(L, h, locale);
    if (nb.items.length) {
      // keep the face's marks / totals when the attachment has none
      if (nb.items.length === 1 && best.items.length === 1) for (const k of ['marks', 'gross_kg', 'volume_cbm', 'quantity', 'unit', 'po_number']) if (nb.items[0][k] == null && best.items[0][k] != null) setV(nb.items[0], k, best.items[0][k], best.items[0].scores[k]);
      best = nb; break;
    }
  }
  const hs = String(f.hs_codes?.value ?? '').split(/,\s*/).filter(Boolean);
  if (best.items.length === 1 && hs.length === 1 && best.items[0].hs_code == null && /HS\s*CODE/i.test(doc.text)) setV(best.items[0], 'hs_code', hs[0], Math.min(0.95, f.hs_codes?.confidence ?? 0.8));
  res.lineItems.push(...best.items);
  // one container: the cargo totals are its totals
  if (res.containers.length === 1 && best.items.length && best.items.some((x) => String(x.marks ?? '').replace(/\W/g, '').includes(String(res.containers[0].container_number).slice(0, 10)))) {
    const c = res.containers[0];
    const sum = (k: string) => best.items.every((x) => typeof x[k] === 'number') ? best.items.reduce((a, x) => a + x[k], 0) : null;
    const q = sum('quantity'), g = sum('gross_kg'), v = sum('volume_cbm');
    if (c.packages == null && q != null) setV(c, 'packages', q, 0.9);
    if (c.gross_kg == null && g != null) setV(c, 'gross_kg', g, 0.9);
    if (c.volume_cbm == null && v != null) setV(c, 'volume_cbm', v, 0.9);
  }
}

// ---------------------------------------------------------------- totals check ----
function lev(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[b.length];
}
/**
 * Scanned tables: when most rows of a column read the same text, a value one or two characters off that majority is
 * probably an OCR misread ("FCI-068.0-EXP" among eleven "FCI-066.0-EXP"). The value is kept, its score drops to review.
 */
function consensus(rows: LineItem[], hdr: Line) {
  if (rows.length < 3 || !hdr) return;
  for (const k of ['marks', 'part_number', 'customer_part_number', 'package_type', 'description', 'po_number']) {
    const vals = rows.map((r) => r[k]).filter((v): v is string => typeof v === 'string');
    if (vals.length < 3) continue;
    const cnt = new Map<string, number>(); for (const v of vals) cnt.set(v, (cnt.get(v) ?? 0) + 1);
    const [maj, n] = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n < 0.6 * vals.length) continue;
    for (const r of rows) if (typeof r[k] === 'string' && r[k] !== maj && lev(r[k], maj) <= 2 && r.scores[k] < 1) {
      r.scores[k] = Math.min(r.scores[k], 0.7);
      (r.issues ??= []).push(`${k}: "${r[k]}" differs from "${maj}" on the other rows by ${lev(r[k], maj)} character(s) (OCR?)`);
    }
  }
}
/** Physical sanity on one row: net weight cannot exceed gross weight. */
function sanity(rows: LineItem[], res: LineResult) {
  for (const r of rows) if (typeof r.net_kg === 'number' && typeof r.gross_kg === 'number' && r.net_kg > r.gross_kg + 0.001) {
    r.scores.net_kg = Math.min(r.scores.net_kg, 0.6); r.scores.gross_kg = Math.min(r.scores.gross_kg, 0.6);
    res.checks.push({ check: 'row: net weight <= gross weight', status: 'fail', detail: `${r.package_id ?? r.part_number ?? r.description ?? ''}: net ${r.net_kg} > gross ${r.gross_kg}` });
  }
}
function reconcile(rows: LineItem[], tot: LineItem, res: LineResult, where: string) {
  for (const k of ['quantity', 'net_kg', 'gross_kg', 'volume_cbm', 'amount']) {
    if (typeof tot[k] !== 'number') continue;
    const vals = rows.filter((r) => typeof r[k] === 'number');
    if (!vals.length) continue;
    // gross / cbm can be printed once per package (last row of a carton): the sum is over rows that carry it
    const sum = Math.round(vals.reduce((s, r) => s + (r[k] as number), 0) * 1000) / 1000;
    const want = tot[k] as number;
    const ok = Math.abs(sum - want) <= Math.max(0.011, want * 0.002);
    res.checks.push({ check: `${where === 'packages' ? 'packages' : 'line items'}: Σ ${k} = printed total`, status: ok ? 'pass' : 'fail', detail: `Σ ${sum} vs total ${want}` });
    for (const r of vals) { r.scores[k] = ok ? Math.max(r.scores[k] ?? 0, 0.97) : Math.min(r.scores[k] ?? 1, 0.7); r.confidence = Math.min(...Object.values(r.scores)); }
  }
}

// ---------------------------------------------------------------- entry ----
/** Containers without a type: a single type stated on the BL face ("1/40'HC CONTAINER") is theirs. */
function containerTypes(doc: Doc, res: LineResult) {
  const types = new Set([...doc.text.matchAll(/\b(20|40|45)\s*'?\s*(HC|HQ|GP|DV|RF|OT|HD|DC)\s*(?:CONTAINER|CNTR|\))/gi)].map((m) => `${m[1]}${m[2]}`.toUpperCase()));
  if (types.size === 1) for (const c of res.containers) if (c.container_type == null) setV(c, 'container_type', [...types][0], 0.9);
}

export function extractLineItems(doc: Doc, locale: Locale, docType = 'PACKING_LIST', fields: Record<string, any> = {}): LineResult {
  const res: LineResult = { lineItems: [], packages: [], containers: [], checks: [] };
  if (docType === 'BILL_OF_LADING' || docType === 'TELEX_RELEASE') {
    containers(doc, locale, res);
    blGoods(doc, fields, res, locale);
    containerTypes(doc, res);
    for (const [k, fk] of [['packages', 'total_packages'], ['gross_kg', 'gross_weight_kg']] as const) {
      const tot = fields[fk]?.value;
      if (res.containers.length < 2 || typeof tot !== 'number' || !res.containers.every((c) => typeof c[k] === 'number')) continue;
      const sum = res.containers.reduce((a, c) => a + c[k], 0);
      const ok = Math.abs(sum - tot) <= Math.max(0.5, tot * 0.002);
      res.checks.push({ check: `containers: Σ ${k} = BL total`, status: ok ? 'pass' : 'fail', detail: `Σ ${r2(sum)} vs ${tot}` });
      for (const c of res.containers) c.scores[k] = ok ? Math.max(c.scores[k], 0.97) : Math.min(c.scores[k], 0.6);
    }
  } else if (docType === 'PACKING_LIST' || docType === 'COMMERCIAL_INVOICE') {
    blocks(doc, locale, res);
    if (!res.lineItems.length) tables(doc, locale, res);
    freePackages(doc, locale, res);
  } else if (docType === 'AIR_WAYBILL') {
    awbGoods(doc, fields, res);
  }
  // OCR-misread box ids: an id-only package next to a near-identical id that carries the data is the same package
  for (const a of [...res.packages]) {
    if (a.package_id == null || a.dimensions_cm != null || a.gross_kg != null) continue;
    const b = res.packages.find((x) => x !== a && x.package_id != null && (x.dimensions_cm != null || x.gross_kg != null) && lev(String(x.package_id), String(a.package_id)) <= 2 && !res.lineItems.some((it) => (it.package_id ?? it.package_ref) === x.package_id));
    if (!b) continue;
    for (const it of res.lineItems) for (const k of ['package_id', 'package_ref']) if (it[k] === a.package_id) it.scores[k] = Math.min(it.scores[k] ?? 0.7, 0.7);
    b.package_id = a.package_id; b.scores.package_id = 0.7;
    res.packages.splice(res.packages.indexOf(a), 1);
  }
  // NIMR material number (00182181R1) from either part column: the key the client's ERP matches on (derived)
  for (const it of res.lineItems) for (const k of ['customer_part_number', 'part_number']) {
    const m = typeof it[k] === 'string' ? it[k].match(/\b(\d{8}R[0-9])\b/) : null;
    if (m && it.nimr_part_number == null) { it.nimr_part_number = m[1]; it.scores.nimr_part_number = it.scores[k]; }
  }
  for (const r of [...res.lineItems, ...res.packages, ...res.containers]) {
    for (const k of Object.keys(r)) if (r[k] === '' || r[k] == null) { delete r[k]; delete r.scores[k]; }
    r.confidence = Object.keys(r.scores).length ? Math.min(...Object.values(r.scores)) : 0;
  }
  return res;
}

/** AWB goods: pieces / gross / chargeable from the header fields, description and dims from the goods box. */
function awbGoods(doc: Doc, f: Record<string, { value: any; confidence: number }>, res: LineResult) {
  const L = doc.lines;
  const hi = L.findIndex((l) => /NATURE\s*AND\s*QUANTITY\s*OF\s*GOODS/i.test(l.text));
  if (hi < 0) return;
  const col = L[hi].segments.find((s) => /NATURE/i.test(s.text))!;
  const it: LineItem = { page: L[hi].page, source: 'awb', scores: {}, confidence: 1 };
  const desc: string[] = []; let conf = 1;
  for (let k = hi + 1; k < Math.min(L.length, hi + 12); k++) {
    const l = L[k];
    if (l.page !== L[hi].page || /WEIGHT\s*CHARGE|PREPAID|OTHER\s*CHARGES/i.test(l.text)) break;
    for (const s of l.segments) {
      if (s.x0 < col.x0 - 0.03) continue;
      const tx = s.text.trim();
      if (/INCL\.?\s*DIMENSIONS|VOLUME\)/i.test(tx)) continue;
      const hs = tx.match(/HS\s*CODE\s*:?\s*([\d.]{6,13})/i);
      const d = /DIMS?|DIMENSIONS/i.test(tx) ? tx.match(/(\d+)\s*X\s*(\d+\s*X\s*\d+\s*X\s*\d+)/i) : null;
      const vol = tx.match(/VOL(UME)?\s*:?\s*(\d[\d.,]*)\s*(CBM|M3)/i);
      if (hs) { const n = normHs(hs[1]); if (n) setV(it, 'hs_code', n, r2(s.conf)); }
      else if (d) { setV(it, 'dimensions_cm', dims(d[2])!.v, r2(s.conf * 0.95)); }
      else if (vol) { const v = parseNumber(vol[2], 'us'); if (v) setV(it, 'volume_cbm', v.value, r2(s.conf)); }
      else if (/[A-Za-z]{3}/.test(tx)) { desc.push(tx); conf = Math.min(conf, s.conf); }
    }
  }
  if (desc.length) setV(it, 'description', desc.join(' '), r2(conf * 0.9));
  for (const [k, src] of [['quantity', 'pieces'], ['gross_kg', 'gross_weight_kg']] as const) if (f[src]) setV(it, k, Number(f[src].value), Math.min(0.95, f[src].confidence + 0.1));
  if (Object.keys(it.scores).length) res.lineItems.push(it);
}

