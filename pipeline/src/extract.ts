// Per-document-type field extraction: label anchors + regex + validators. No training required.
import type { DocType, Extraction, FieldValue, LineItem, PageData } from './types';
import { anchor, block, findAll, bboxOf, type Doc, type Hit } from './anchors';
import { matchParty, resolveAirport, resolvePort, resolveCountry, isCurrency, isIata, levenshtein } from './gazetteer';
import { validAwb, formatAwb, fixContainer, normIncoterm, normHs, parseNumber, detectLocale, parseDate, RE, repairDigits } from './validators';
import { extractLineItems } from './lineitems';
import { keyValues, captionBelow, looksLikeLabel, plausible } from './labels';
import { isFamiliar } from './layouts';

type Fields = Record<string, FieldValue>;

/** Date convention of the issuing country: resolves dd/mm vs mm/dd ambiguity. */
const CTX: { dateConv: 'US' | 'DMY' | null } = { dateConv: null };
function pDate(s: string) {
  const r = parseDate(s, CTX.dateConv === 'US');
  if (r && r.ambiguous && CTX.dateConv) return { iso: r.iso, ambiguous: false };
  return r;
}

const BASE: Record<string, number> = { 'same-segment': 0.95, right: 0.92, below: 0.86, block: 0.88, regex: 0.72, derived: 0.8, gazetteer: 0.95 };

/** OCR reads the letter O in code prefixes (SO, PO, DO, INV) as zero: "S09319" -> "SO9319". */
function fixPrefix(v: string): string { return v.replace(/^([SPD])0(?=\d{3,}$)/, '$1O'); }

function put(fields: Fields, key: string, value: FieldValue['value'], hit: Hit | null, opts: { method?: string; valid?: boolean; ambiguous?: boolean; issues?: string[]; boost?: number } = {}) {
  if (value === null || value === undefined || value === '') return;
  if (fields[key] && fields[key].confidence >= (opts.boost ?? 0)) return; // first good hit wins unless boosted
  const method = opts.method ?? hit?.method ?? 'regex';
  let c = (BASE[method] ?? 0.75) * Math.min(1, Math.max(0.5, hit?.conf ?? 0.9) + 0.05);
  if (opts.valid === true) c = Math.min(0.99, c + 0.08);
  if (opts.valid === false) c *= 0.45;
  if (opts.ambiguous) c *= 0.75;
  fields[key] = { value, raw: hit?.raw, page: hit?.line.page, bbox: bboxOf(hit), confidence: Number(c.toFixed(2)), method, valid: opts.valid, issues: opts.issues };
  // recognition confidence of the actual OCR segment (synthetic hits carry a default conf and no segment)
  let srcSeg = hit?.seg;
  if (!srcSeg && hit?.line && hit.value) { const needle = String(hit.value).replace(/\s/g, ''); srcSeg = hit.line.segments.find((x) => x.text.replace(/\s/g, '').includes(needle)); }
  const sc = srcSeg ? (hit?.seg ? Math.min(srcSeg.conf, hit.conf ?? 1) : srcSeg.conf) : undefined;
  if (sc !== undefined && sc < 1) fields[key].sourceConf = Number(sc.toFixed(3));
}

const lbl = (s: string) => new RegExp(s.split(' ').join('\\s*'), 'i'); // OCR-tolerant label: spaces optional

// ----------------------------------------------------------------------------------------------
function partyFromBlock(h: Hit | null): { name: string; address: string; known: boolean } | null {
  if (!h) return null;
  const lines = h.value.split('\n').map((s) => s.trim()).filter((l) => l && !/^(ATT(N)?[:.]|ATTENTION|MR\.?\s|MRS\.?\s|MS\.?\s)/i.test(l));
  for (let i = 0; i < Math.min(lines.length, 4); i++) {
    const known = matchParty(lines[i]) ?? (i + 1 < lines.length ? matchParty(lines[i] + ' ' + lines[i + 1]) : null);
    if (known) return { name: known.name, address: lines.slice(i + 1).join(', '), known: true };
  }
  const first = lines.find((l) => /[A-Za-z]{3}/.test(l) && !/^\d|^(NO|ID)[:.\s]/i.test(l));
  if (!first) return null;
  return { name: first, address: lines.slice(lines.indexOf(first) + 1).join(', '), known: false };
}

function putParty(f: Fields, key: string, h: Hit | null) {
  const p = partyFromBlock(h);
  if (!p) return;
  put(f, key, p.name, h, { valid: p.known ? true : undefined, method: p.known ? 'gazetteer' : 'block' });
  if (p.address) put(f, `${key}_address`, p.address, h);
}

/** Letterhead issuer: known party in the top 25% of page 1, else first line with a company suffix. */
function letterhead(doc: Doc, exclude: string[]): Hit | null {
  const top = doc.lines.filter((l) => l.page === 1 && l.y < 0.25);
  for (const l of top) {
    const m = matchParty(l.text);
    if (m && !exclude.includes(m.name)) return { value: m.name, raw: l.text, line: l, method: 'block', conf: l.segments[0]?.conf ?? 0.9 };
  }
  for (const l of top) for (const s of l.segments) {
    if (/\b(GMBH|LTD|LLC|INC|PTY|CORP|S\.?A\.?|CO\.|LIMITED|FZE|FZCO|PT\.)\b/i.test(s.text) && !/NIMR/i.test(s.text)) {
      return { value: s.text.replace(/^.*?(?=[A-Z])/i, ''), raw: s.text, line: l, seg: s, method: 'block', conf: s.conf };
    }
  }
  return null;
}

// ---- weights & numbers ----------------------------------------------------------------------
interface WCand { kg: number; amb: boolean; alt?: number; hit: Hit; labelled: boolean }

function weightCandidates(doc: Doc, locale: 'eu' | 'us' | 'auto'): WCand[] {
  const out: WCand[] = [];
  for (const l of doc.lines) {
    const re = /(\d[\d.,]*)\s*(KGS?|KG'?S|KILOS?|K)\b(?!\s*[A-Z]{2})/gi;
    for (const m of l.text.matchAll(re)) {
      const p = parseNumber(m[1], locale);
      if (!p || !isFinite(p.value) || p.value <= 0) continue;
      const alt = p.ambiguous ? parseNumber(m[1], locale === 'eu' ? 'us' : 'eu')?.value : undefined;
      out.push({ kg: p.value, amb: p.ambiguous, alt, hit: { value: m[0], raw: l.text, line: l, method: 'regex', conf: l.segments[0]?.conf ?? 0.9 }, labelled: /GROSS|BRUTTO|TOTAL\s*W/i.test(l.text) });
    }
    const lb = /(\d[\d.,]*)\s*LBS?\b/gi;
    for (const m of l.text.matchAll(lb)) {
      const p = parseNumber(m[1], locale);
      if (p) out.push({ kg: Math.round(p.value * 0.45359237 * 100) / 100, amb: false, hit: { value: m[0], raw: l.text, line: l, method: 'regex', conf: 0.85 }, labelled: false });
    }
  }
  return out;
}

/** Resolve "270,000" (=270.000 kg) vs "7,168" (=7168 kg) using other unambiguous mentions in the doc. */
function resolveWeight(c: WCand, all: WCand[]): { kg: number; ambiguous: boolean } {
  if (!c.amb) return { kg: c.kg, ambiguous: false };
  const others = all.filter((o) => !o.amb).map((o) => o.kg);
  if (c.alt !== undefined && others.some((o) => Math.abs(o - c.alt!) < 0.01)) return { kg: c.alt, ambiguous: false };
  if (others.some((o) => Math.abs(o - c.kg) < 0.01)) return { kg: c.kg, ambiguous: false };
  return { kg: c.kg, ambiguous: true };
}

function grossWeight(doc: Doc, f: Fields, locale: 'eu' | 'us' | 'auto') {
  const all = weightCandidates(doc, locale);
  // 0) label wrapped over two lines: "... Total Gross" / "Weight: 2760kg"
  for (let i = 0; i + 1 < doc.lines.length; i++) {
    if (!/GR[O0]SS\s*$/i.test(doc.lines[i].text)) continue;
    const m = doc.lines[i + 1].text.match(/^\s*WEIGHT\s*[:.]?\s*(\d[\d.,]*)\s*KGS?/i);
    if (m) { const p = parseNumber(m[1], locale); if (p) { put(f, 'gross_weight_kg', p.value, { value: m[1], raw: doc.lines[i + 1].text, line: doc.lines[i + 1], method: 'same-segment', conf: doc.lines[i + 1].segments[0]?.conf ?? 0.9 }); return; } }
  }
  // 1) labelled anchors
  let h = anchor(doc, /GROSS\s*(WEIGHT|WEIGH|WT\.?|W\.?)|BRUTTO|TOTAL\s*GR[O0]SS\s*WEIGHT|TOTAL\s*WEIGHT|^GROSS$/i, /(?<![A-Z0-9.,:])(\d[\d.,]*\d|\d)(?![\d.,]*\s*(LBS?|IB)\b)(?=\s*(KGS?\b|KG'?S|K\b)|[^A-Z0-9:.,]|$)/i, { below: 4, colWidth: 0.18 });
  if (h && h.method === 'below') h = columnTotal(doc, h) ?? h;
  // same line also states kg explicitly (e.g. "Total weight: 865 lb. Or 381 kg.")
  if (h) { const kgM = h.line.text.match(/(\d[\d.,]*)\s*KGS?\b/i); if (kgM && /LB/i.test(h.line.text)) h = { ...h, value: kgM[1] }; }
  if (h) {
    const p = parseNumber(h.value, locale);
    if (p && p.value > 0) {
      const alt = p.ambiguous ? parseNumber(h.value, locale === 'eu' ? 'us' : 'eu')?.value : undefined;
      const r = resolveWeight({ kg: p.value, amb: p.ambiguous, alt, hit: h, labelled: true }, all);
      put(f, 'gross_weight_kg', Math.round(r.kg * 1000) / 1000, h, { ambiguous: r.ambiguous });
      return;
    }
  }
  // 2) the largest weight on lines that mention gross/total, else the largest KG value overall
  const totals = all.filter((c) => /TOTAL|SUBTOTAL|\d+\s*PACKAGES|SUMME|GESAMT/i.test(c.hit.line.text));
  const pool = all.filter((c) => c.labelled).length ? all.filter((c) => c.labelled) : totals.length ? totals : all;
  if (!pool.length) return;
  const best = pool.map((c) => ({ c, r: resolveWeight(c, all) })).sort((a, b) => b.r.kg - a.r.kg)[0];
  put(f, 'gross_weight_kg', best.r.kg, best.c.hit, { method: 'derived', ambiguous: best.r.ambiguous });
}

/** For a value found under a column header, prefer the TOTAL/SUBTOTAL row of that column. */
function columnTotal(doc: Doc, h: Hit): Hit | null {
  if (!h.seg) return null;
  const col = { x0: h.seg.x0 - 0.04, x1: h.seg.x1 + 0.04 };
  const idx = doc.lines.indexOf(h.line);
  for (let i = idx; i < doc.lines.length; i++) {
    const l = doc.lines[i];
    if (l.page !== h.line.page) break;
    if (!/TOTAL|SUMME|GESAMT|\d+\s*PACKAGES/i.test(l.text)) continue;
    for (const cand of [l, doc.lines[i + 1]]) {
      if (!cand || cand.page !== l.page) continue;
      const ov = (s: { x0: number; x1: number }) => Math.min(s.x1, col.x1) - Math.max(s.x0, col.x0);
      const seg = cand.segments.filter((s) => ov(s) > 0 && /\d/.test(s.text)).sort((a, b) => ov(b) - ov(a))[0];
      if (seg) {
        const m = seg.text.match(/(\d[\d.,]*\d)\s*(KGS?)?\s*$/i) ?? seg.text.match(/(\d[\d.,]*\d)/);
        if (m) return { value: m[1], raw: cand.text, line: cand, seg, method: 'below', conf: seg.conf };
      }
    }
  }
  return null;
}

function netWeight(doc: Doc, f: Fields, locale: 'eu' | 'us' | 'auto') {
  let h = anchor(doc, /NET\s*WEIGHT|NETWEIGHT|NET\s*W(T|\.)|NET\s*KG|NETTO|^NET$|^NET(?=\s*GROSS)/i, /(?<![A-Z0-9.,])(\d[\d.,]*\d)(?![A-Z0-9])/i, { below: 4, colWidth: 0.15 });
  if (h && h.method === 'below') h = columnTotal(doc, h) ?? h;
  if (!h) return;
  const p = parseNumber(h.value, locale);
  if (p && p.value > 0) put(f, 'net_weight_kg', p.value, h, { ambiguous: p.ambiguous });
}

function volume(doc: Doc, f: Fields, locale: 'eu' | 'us' | 'auto') {
  // explicit unit first ("0,600 cbm"), unless a header column itself is labelled (CBM)/M3
  const hdr = anchor(doc, /^\(?(CBM|M3)\)?$|MEASUREMENT\s*\(?(CBM|M3)/i, /^(\d[\d.,:]*)\s*(CBM|M3|M³)?$/i, { below: 3, colWidth: 0.1 });
  const unitHit = findAll(doc, /(\d[\d.,]*)\s*(CBM|M3|M³)\b/i).find((m) => !/\/\s*[\d.]+\s*CBM/i.test(m.line.text)); // skip per-container lines "…/22.0000CBM"
  const h = hdr ?? (unitHit ? { value: unitHit.value, raw: unitHit.line.text, line: unitHit.line, method: 'regex' as const, conf: 0.9 } : null);
  if (h) {
    const p = parseNumber(h.value.replace(':', '.'), 'eu' === locale ? 'eu' : 'us'); // CBM: "43.000" / "0,600" are decimals
    if (p && p.value >= 0) { put(f, 'volume_cbm', p.value, h); return; }
  }
  for (const m of findAll(doc, /(\d[\d.,]*)\s*(CBM|M3|M³)\b/i)) {
    const p = parseNumber(m.value, locale);
    if (p && p.value > 0) { put(f, 'volume_cbm', p.value, { value: m.value, raw: m.line.text, line: m.line, method: 'regex', conf: 0.9 }); return; }
  }
}

function packages(doc: Doc, f: Fields) {
  const m = findAll(doc, /(?<![X×x*]\s*)(?<![\d.,])\b(\d{1,5})\s*(PKGS?|PACKAGES?|PACKAGE\s*\(S\)|PALLETS?|CTNS?|CARTONS?|COLLI|PIECES|PCS\s*PALLET)\b/i);
  const tot = findAll(doc, /TOTAL[^0-9]{0,30}?(\d{1,5})\s*(PKGS?|PACKAGES?|PACKAGE\(S\)|PALLETS?|CTNS?|COLLI)/i);
  if (!tot[0] && !m.length) {
    const ids = new Set<string>();
    let hdrLine: Doc['lines'][number] | undefined;
    for (const l of doc.lines) {
      const hs = l.segments.find((s) => /^(BOX|PALLET\s*NO\.?|PACKAGE\s*(ID|NO\.?)|PACKAGE\s*COUNT)$/i.test(s.text.trim()));
      if (hs) { hdrLine = l; continue; }
      if (hdrLine && l.page === hdrLine.page) for (const s of l.segments.slice(0, 1)) { const mm = s.text.match(/^([A-Z]{2,}\d{4,})$/); if (mm) ids.add(mm[1]); }
    }
    if (ids.size && hdrLine) { put(f, 'total_packages', ids.size, { value: String(ids.size), raw: [...ids].join(','), line: hdrLine, method: 'derived', conf: 0.9 }, { method: 'derived' }); return; }
  }
  const h = tot[0] ?? m.sort((a, b) => Number(b.value) - Number(a.value))[0];
  if (h) put(f, 'total_packages', Number(h.value), { value: h.value, raw: h.line.text, line: h.line, method: 'regex', conf: 0.9 }, { method: tot[0] ? 'right' : 'regex' });
}

// ---- common identifiers ----------------------------------------------------------------------
function commonIds(doc: Doc, f: Fields) {
  const pos = [...new Set(findAll(doc, RE.po).map((m) => m.value))];
  if (pos.length) put(f, 'po_numbers', pos.join(', '), { value: pos[0], raw: pos.join(','), line: findAll(doc, RE.po)[0].line, method: 'regex', conf: 0.95 }, { valid: true });
  const srn = [...new Set(findAll(doc, RE.srn).map((m) => m.value))];
  if (srn.length) put(f, 'shipment_ref', srn.join(', '), { value: srn[0], raw: srn[0], line: findAll(doc, RE.srn)[0].line, method: 'regex', conf: 0.95 }, { valid: true });

  const inc = anchor(doc, /INCO\s*TERMS?|DELIVERY\s*TERMS?|TERMS\s*OF\s*DELIVERY|LIEFERBEDINGUNG|SHIPPING:|\bTERMS:/i, /(.{2,30})/, { below: 1 });
  const incV = inc ? normIncoterm(inc.value) : null;
  if (incV) put(f, 'incoterm', incV, inc, { valid: true });
  else { const g = findAll(doc, /\b(EXW|EX\s*-?\s*WORKS|FCA|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)\b/i)[0]; if (g) put(f, 'incoterm', normIncoterm(g.value), { value: g.value, raw: g.line.text, line: g.line, method: 'regex', conf: 0.9 }, { valid: true }); }

  const coo = anchor(doc, /COUNTRY\s*OF\s*ORIGIN|ORIGIN:|URSPRUNGSLAND/i, /([A-Za-z][A-Za-z .]{2,40})/, { below: 1 });
  const cooV = coo ? resolveCountry(coo.value.replace(/\(.*$/, '').trim()) : null;
  if (cooV) put(f, 'country_of_origin', cooV, coo, { valid: true });

  const hs = new Set<string>();
  for (let li = 0; li < doc.lines.length; li++) {
    const l = doc.lines[li];
    const prev = doc.lines[li - 1];
    const cont = prev && /(HS|TARIFF)[^\n]*\d{6,10},\s*$/i.test(prev.text) && /^\s*\d{6,10}/.test(l.text);
    if (!cont && !/HS|TARIFF|ZOLLTARIF|COMMODITY\s*CODE/i.test(l.text) && !/\b\d{4}\.\d{2}\.\d{2}\b/.test(l.text)) continue;
    for (const m of l.text.matchAll(/(?<![\d.])(\d{4}\.?\d{2}\.?\d{2}(\d{2})?)(?![\d.])/g)) { const n = normHs(m[1]); if (n && !/^45\d{8}$/.test(n)) hs.add(n); }
  }
  // tables with an HS-Code column: numbers aligned under the header
  const hsHdr = anchor(doc, /HS[-\s]*CODE|TARIFF\s*CODE/i, /\b(\d{8,10})\b/, { below: 6, colWidth: 0.08 });
  if (hsHdr?.seg && hsHdr.method === 'below') {
    // collect every value in that column (table with one HS code per row)
    const col = { x0: hsHdr.seg.x0 - 0.01, x1: hsHdr.seg.x1 + 0.01 };
    for (const l of doc.lines) if (l.page === hsHdr.line.page && l.y >= hsHdr.line.y) for (const sg of l.segments) {
      if (Math.min(sg.x1, col.x1) - Math.max(sg.x0, col.x0) <= 0) continue;
      const m = sg.text.match(/^\s*(\d{8,10})\s*$/); const n = m ? normHs(m[1]) : null; if (n && !/^45\d{8}$/.test(n)) hs.add(n);
    }
  } else if (hsHdr) { const n = normHs(hsHdr.value); if (n && !/^45\d{8}$/.test(n)) hs.add(n); }
  if (hs.size) put(f, 'hs_codes', [...hs].join(', '), { value: '', raw: [...hs].join(','), line: doc.lines[0], method: 'regex', conf: 0.9 }, { valid: true });
}

function docDate(doc: Doc, f: Fields, labels: RegExp, preferUS = false) {
  const h = anchor(doc, labels, RE.date, { below: 2 });
  const p = h ? pDate(h.value) : null;
  if (p) { put(f, 'document_date', p.iso, h, { valid: true, ambiguous: p.ambiguous }); return; }
  const any = findAll(doc, RE.date).map((m) => ({ m, p: pDate(m.value) })).find((x) => x.p);
  if (any) put(f, 'document_date', any.p!.iso, { value: any.m.value, raw: any.m.line.text, line: any.m.line, method: 'regex', conf: 0.85 }, { ambiguous: any.p!.ambiguous });
}

// ---- per type --------------------------------------------------------------------------------
function extractBL(doc: Doc, f: Fields, locale: 'eu' | 'us' | 'auto') {
  const blNo = anchor(doc, /B\s*\/?\s*L\s*NO\.?|BILL\s*OF\s*LADING\s*(NO|NUMBER)\.?|HBOL\s*NO|HB\/?L\s*NO|COMBINED\s*TRANSPORT\s*BILL\s*OF\s*LADING|^FBL$|BOOKING\s*NO/i,
    /\b([A-Z0-9][A-Z0-9/-]{5,24})\b/, { below: 2, reject: /^(NEGOTIABLE|MULTIMODAL|ORIGINAL|COPY)$/i });
  if (blNo && /\d/.test(blNo.value)) put(f, 'bl_number', blNo.value, blNo);
  putParty(f, 'shipper', block(doc, /^(SHIPPER\s*\/?\s*(MERCHANT|EXPORTER)?|CONSIGNOR|EXPORTER)\b(?!'S|\s*'S|\s*ADDRESS|\s*CERTIF)/i));
  putParty(f, 'consignee', block(doc, /^(CONSIGNEE|CONSIGNED\s*TO(\s*ORDER\s*OF)?)\b/i));
  const notify = block(doc, /^NOTIFY\s*(PARTY|ADDRESS)?/i, { maxLines: 4 });
  if (notify && /SAME\s*AS\s*CONSIGNEE/i.test(notify.value)) put(f, 'notify_party', 'SAME AS CONSIGNEE', notify);
  else putParty(f, 'notify_party', notify);

  const vessel = anchor(doc, /OCEAN\s*VESSEL|VESSEL\s*(NAME|\/\s*VOYAGE)?|^PER\b/i, /([A-Z][A-Z0-9 .()\/-]{3,45})/, { below: 2, colWidth: 0.25, right: false,
    reject: /^(PORT|VOYAGE|NAME|NO\b)|\b(OF|DELIVERY|LOADING|DISCHARGE|CARRIAGE|PLACE|RECEIPT)\b/i });
  if (vessel) {
    const v = vessel.value.replace(/^[:\s]+/, '').replace(/\s+/g, ' ').trim();
    const m = v.match(/^(.*?)[\s(]+(V\.?\s*)?([0-9][A-Z0-9]{2,10}|[A-Z0-9]{3,10}[0-9][A-Z0-9]*)\)?$/i);
    put(f, 'vessel', (m ? m[1] : v).trim(), vessel);
    if (m) put(f, 'voyage', m[3], vessel);
    else if (vessel.seg) {
      const i = doc.lines.indexOf(vessel.line);
      const nx = doc.lines[i + 1];
      const sg = nx?.segments.find((x) => Math.min(x.x1, vessel.seg!.x1) - Math.max(x.x0, vessel.seg!.x0) > 0);
      const vm = sg?.text.match(/^V(?:OY)?\.?\s*([A-Z0-9]{3,12})$/i);
      if (vm) put(f, 'voyage', vm[1], { ...vessel, line: nx!, seg: sg, raw: sg!.text });
    }
  }
  const portField = (key: string, label: RegExp) => {
    const h = anchor(doc, label, /([A-Za-z][A-Za-z ,.'()-]{2,40})/, { below: 2, colWidth: 0.2, right: false,
      reject: /^(PORT|PLACE|VESSEL|FINAL|OCEAN|IDENTIFIERS|TRAKK|NUMBER|FREIGHT|PRE-?\s*CARRIAGE|ON\s*CARRIAGE|EXCESS|BY\s)|\b(OF\s*(LOADING|DISCHARGE|DELIVERY|RECEIPT)|CARRIER|DOCUMENT|VERIFY)\b/i });
    if (!h) return;
    const p = resolvePort(h.value);
    put(f, key, h.value.replace(/[,.\s]+$/, ''), h, { valid: p ? true : undefined });
    if (p) put(f, `${key}_locode`, p.locode, h, { valid: true });
  };
  portField('port_of_loading', /PORT\s*OF\s*LOADING/i);
  portField('port_of_discharge', /PORT\s*OF\s*DISCHARGE/i);
  portField('place_of_receipt', /PLACE\s*OF\s*RECEIPT(\s*BY\s*PRE-?\s*CARRIER)?|PLACE\s*OF\s*ACCEPTANCE/i);
  portField('place_of_delivery', /PLACE\s*OF\s*DELIVERY(\s*BY\s*ON-?\s*CARRIER)?|FINAL\s*DESTINATION/i);

  const containers = new Map<string, boolean>();
  for (const l of doc.lines) for (const m of l.text.replace(/\s{2,}/g, ' ').matchAll(/\b([A-Z]{3}[UJZ])[\s-]?(\d{6})[\s-]?(\d)?\b/g)) {
    const fx = fixContainer(m[1] + m[2] + (m[3] ?? ''));
    if (!containers.has(fx.value) || fx.valid) containers.set(fx.value, fx.valid);
  }
  if (containers.size) {
    const vals = [...containers.entries()];
    const allValid = vals.every(([, v]) => v);
    put(f, 'container_numbers', vals.map(([k]) => k).join(', '), { value: '', raw: '', line: doc.lines[0], method: 'regex', conf: 0.95 }, { valid: allValid, issues: allValid ? undefined : vals.filter(([, v]) => !v).map(([k]) => `${k}: ISO 6346 check digit failed or missing`) });
  }
  const seals = findAll(doc, /SEAL\s*(NO\.?|#|:)?\s*:?\s*([A-Z]{1,4}\d{5,10})/i).map((m) => m.value.match(/([A-Z]{1,4}\d{5,10})$/i)?.[1]).filter(Boolean) as string[];
  const seals2 = findAll(doc, /\/[A-Z]{4}\d{7}\/([A-Z]{0,3}\d{5,10})\//).map((m) => m.value);
  const allSeals = [...new Set([...seals, ...seals2])];
  if (allSeals.length) put(f, 'seal_numbers', allSeals.join(', '), { value: '', raw: '', line: doc.lines[0], method: 'regex', conf: 0.9 });

  const ft = findAll(doc, /\bFREIGHT\s*(PREPAID|COLLECT)\b/i)[0];
  if (ft) put(f, 'freight_terms', ft.value.toUpperCase(), { value: ft.value, raw: ft.line.text, line: ft.line, method: 'regex', conf: 0.95 }, { valid: true });
  const relRe = /\b(TELEX\s*RELEASED?|EXPRESS(\s*B\/?L)?|SEA\s*WAYBILL|B\/?L\s*SURRENDERED)\b/i;
  const relLine = doc.lines.find((l) => l.segments.some((sg) => { const t = sg.text.replace(/[_*]/g, ' '); return relRe.test(t) && (/TELEX|EXPRESS\s*B\/?L|WAYBILL|SURRENDERED/i.test(t) || t.replace(/\s/g, '').length <= 30); }));
  const relM = relLine ? relLine.text.replace(/[_*]/g, ' ').match(relRe) : null;
  const relV = relM ? (/TELEX/i.test(relM[0]) ? 'TELEX RELEASE' : /EXPRESS/i.test(relM[0]) ? 'EXPRESS' : /WAYBILL/i.test(relM[0]) ? 'SEA WAYBILL' : 'SURRENDERED') : 'ORIGINAL';
  put(f, 'release_type', relV, relLine ? { value: relM![0], raw: relLine.text, line: relLine, method: 'regex', conf: 0.95 } : null, { method: relLine ? 'right' : 'derived' });

  const sob = anchor(doc, /SHIPPED\s*ON\s*BOARD|LOADED\s*ON\s*BOARD|LADEN\s*ON\s*BOARD/i, RE.date, { below: 2 });
  const sobD = sob ? pDate(sob.value) : null;
  if (sobD) put(f, 'shipped_on_board_date', sobD.iso, sob, { ambiguous: sobD.ambiguous });
  const issue = anchor(doc, /PLACE\s*AND\s*DATE\s*OF\s*ISSUE|DATE\s*OF\s*ISSUE/i, /([A-Za-z][A-Za-z ]+?)[\s,]+(\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/, { below: 2, colWidth: 0.35 });
  if (issue) {
    const m = issue.value.match(/([A-Za-z][A-Za-z ]+?)[\s,]+(\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/) ?? [];
    const raw = issue.raw.match(/([A-Za-z][A-Za-z ]+?)[\s,]+(\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/);
    const place = (raw?.[1] ?? m[1] ?? '').trim();
    const d = pDate(raw?.[2] ?? issue.value);
    if (place) put(f, 'issue_place', place, issue);
    if (d) { put(f, 'issue_date', d.iso, issue, { ambiguous: d.ambiguous }); put(f, 'document_date', d.iso, issue, { ambiguous: d.ambiguous }); }
  }
  if (!f.document_date && f.shipped_on_board_date) f.document_date = { ...f.shipped_on_board_date, method: 'derived' };
  const carrier = anchor(doc, /OPERATED\s*BY|SIGNED\s*(ON\s*BEHALF\s*OF|AS\s*AGENT)|AS\s*AGENT\s*FOR\s*THE\s*CARRIER|STAMP\s*AND\s*SIGNATURE/i, /([A-Z][A-Za-z&.,' ]{4,60}(LIMITED|LTD|GMBH|LLC|INC|KG|LINE|CO)\b\.?)/i, { below: 3, colWidth: 0.4 });
  if (carrier) put(f, 'carrier_or_issuer', carrier.value, carrier);
  if (f.bl_number) f.document_number = { ...f.bl_number, method: 'derived' };
  grossWeight(doc, f, locale); volume(doc, f, locale); packages(doc, f);
}

function extractAWB(doc: Doc, f: Fields, locale: 'eu' | 'us' | 'auto') {
  // MAWB: "176 MIA 67009386", "607MUC55647491", "176-6700 9386"
  const p1 = doc.lines.filter((l) => l.page === 1);
  for (const l of [...p1.slice(0, 8), ...p1.slice(-6)]) {
    const t = l.text.replace(/[|\[\]]/g, ' ').replace(/\s{2,}/g, ' ');
    const m = t.match(/\b(\d{3})\s*[- ]?\s*(?:[A-Z]{3}\s*)?[- ]?(\d{4})\s?(\d{4})\b/);
    if (m) {
      let num = m[1] + m[2] + m[3];
      let valid = validAwb(num);
      if (!valid) { const r = repairDigits(num); if (validAwb(r)) { num = r; valid = true; } }
      put(f, 'mawb_number', formatAwb(num), { value: num, raw: l.text, line: l, method: 'regex', conf: l.segments[0]?.conf ?? 0.9 }, { valid, issues: valid ? undefined : ['AWB mod-7 check digit failed'] });
      const org = t.match(/\b\d{3}\s*([A-Z]{3})\s*\d{4}/);
      if (org && isIata(org[1])) put(f, 'origin_iata', org[1], { value: org[1], raw: l.text, line: l, method: 'regex', conf: 0.9 }, { valid: true });
      break;
    }
  }
  const hawb = anchor(doc, /HAWB\s*(NO|NUMBER)?\.?|HOUSE\s*AIR\s*WAYBILL\s*(NO|NUMBER)/i, /\b([A-Z0-9][A-Z0-9-]{4,19}[A-Z0-9])\b/, { below: 1, reject: /^(HOUSE|AIR|WAYBILL|ISSUED)/i });
  if (hawb && /\d/.test(hawb.value) && !/MAWB/i.test(hawb.raw.slice(0, Math.max(0, hawb.raw.indexOf(hawb.value))).split(/HAWB/i).pop() ?? '')) put(f, 'hawb_number', hawb.value, hawb);
  const dn = f.hawb_number ?? f.mawb_number;
  if (dn) f.document_number = { ...dn, method: 'derived' };

  putParty(f, 'shipper', block(doc, /^SHIPPER'?S\s*NAME\s*AND\s*ADDRESS/i, { maxLines: 6 }));
  putParty(f, 'consignee', block(doc, /^CONSIGNEE'?S\s*NAME\s*AND\s*ADDRESS/i, { maxLines: 6 }));
  const agentB = block(doc, /^ISSUING\s*CARRIER'?S\s*AGENT/i, { maxLines: 2 }) ?? anchor(doc, /ISSUED\s*BY/i, /([A-Z][A-Za-z.& ]{3,60})/, { below: 2 });
  if (agentB) { const m = matchParty(agentB.value); put(f, 'issuing_agent', m?.name ?? agentB.value.split('\n')[0], agentB, { valid: m ? true : undefined }); }

  const dep = anchor(doc, /AIRPORT\s*OF\s*DEPARTURE/i, /([A-Z][A-Za-z ]{2,30})/, { below: 2, colWidth: 0.3, accept: (v) => !!resolveAirport(v) });
  if (dep) { const a = resolveAirport(dep.value); put(f, 'airport_of_departure', a?.iata ?? dep.value, dep, { valid: a ? true : undefined }); }
  const dest = anchor(doc, /AIRPORT\s*OF\s*DESTINATION/i, /([A-Z][A-Za-z ]{2,30})/, { below: 3, colWidth: 0.2, accept: (v) => !!resolveAirport(v) });
  if (dest) { const a = resolveAirport(dest.value); put(f, 'airport_of_destination', a?.iata ?? dest.value, dest, { valid: a ? true : undefined }); }
  else { const to = anchor(doc, /^TO$/i, /\b([A-Z]{3})\b/, { below: 1 }); if (to && isIata(to.value)) put(f, 'airport_of_destination', to.value, to, { valid: true }); }

  const flRe = /\b((?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\s?\d{2,4})[A-Z]?\b/;
  const fl = anchor(doc, /REQUESTED\s*F[LI][IL]?GHT|FIGH|FLIGHT\s*\/?\s*DATE|REQUIRED\s*FLIGHT/i, flRe, { below: 3, colWidth: 0.2 })
    ?? (() => { const m = findAll(doc, /\b((?:EK|EY|QR|LH|TK|SV|G9|FZ|WY|AI|6E|SQ|CX|BA|AF|KL|CV|5X|FX|LX|OS)\s?\d{2,4})[A-Z]?\b/)[0]; return m ? { value: m.value, raw: m.line.text, line: m.line, method: 'regex' as const, conf: 0.85 } : null; })();
  if (fl) {
    const flights = [...new Set(fl.line.text.match(new RegExp(flRe.source, 'g'))?.map((x) => x.replace(/\s/g, '').replace(/[A-Z]$/, (c) => (/\d[A-Z]$/.test(x) ? '' : c))) ?? [])].filter((x) => /^(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\d{2,4}$/.test(x) && !/^(PP|CC|WT)/.test(x));
    put(f, 'flight', (flights.length ? flights : [fl.value.replace(/\s/g, '')]).join(', '), fl);
  }
  const carrier1 = anchor(doc, /BY\s*FIRST\s*CARRIER/i, /\b([A-Z0-9]{2})\b/, { below: 2, colWidth: 0.1, reject: /^(WT|PP|CC|TO|BY)$/ });
  if (carrier1) put(f, 'first_carrier', carrier1.value, carrier1);

  // pieces / gross / chargeable from the rating line: "3  381.00 K ... 1000.00" or "3 ¦ 591.8 K Q ¦ 592.0"
  for (const l of doc.lines) {
    const m = l.text.replace(/[|\[\]]/g, ' ').replace(/\s{2,}/g, ' ').match(/^\s*(\d{1,4})\s+(\d[\d.,]*)\s*(K|KG|L|LB)\b\s*([A-Z])?\s*(\d[\d.,]*)?/);
    if (m) {
      const h: Hit = { value: m[0], raw: l.text, line: l, method: 'regex', conf: l.segments[0]?.conf ?? 0.9 };
      put(f, 'pieces', Number(m[1]), h, { method: 'below' });
      const g = parseNumber(m[2], 'us');
      if (g) put(f, 'gross_weight_kg', m[3].startsWith('L') ? Math.round(g.value * 0.4536 * 100) / 100 : g.value, h, { method: 'below' });
      const cw = m[5] ? parseNumber(m[5], 'us') : null;
      if (cw) put(f, 'chargeable_weight_kg', cw.value, h, { method: 'below' });
      break;
    }
  }
  const cur = anchor(doc, /CURR?ENCY/i, /\b([A-Z]{3})\b/, { below: 2, colWidth: 0.08 });
  if (cur && isCurrency(cur.value)) put(f, 'currency', cur.value, cur, { valid: true });
  const ccpp = findAll(doc, /\b(FREIGHT\s*(COLLECT|PREPAID)|\bCC\b|\bPP\b)/)[0];
  if (ccpp) put(f, 'freight_terms', /COLLECT|CC/.test(ccpp.value) ? 'COLLECT' : 'PREPAID', { value: ccpp.value, raw: ccpp.line.text, line: ccpp.line, method: 'regex', conf: 0.9 });
  let ex = anchor(doc, /EXECUTED\s*ON/i, RE.date, { below: 1, colWidth: 0.12 });
  if (!ex) { // value printed above the caption
    const lab = doc.lines.find((l) => /EXECUTED\s*ON/i.test(l.text));
    if (lab) {
      const ls = lab.segments.find((x) => /EXECUTED/i.test(x.text))!;
      const i = doc.lines.indexOf(lab);
      for (const pl of [doc.lines[i - 1], doc.lines[i - 2]]) {
        const sg = pl?.segments.find((x) => Math.min(x.x1, ls.x1 + 0.03) - Math.max(x.x0, ls.x0 - 0.03) > 0 && RE.date.test(x.text));
        if (sg) { ex = { value: sg.text.match(RE.date)![0], raw: sg.text, line: pl!, seg: sg, method: 'below', conf: sg.conf }; break; }
      }
    }
  }
  const exD = ex ? pDate(ex.value) : null;
  if (exD) put(f, 'document_date', exD.iso, ex, { ambiguous: exD.ambiguous });
  const ref = anchor(doc, /REFERENCE\s*NUMBER/i, /\b([A-Z0-9]{6,20})\b/, { below: 2, colWidth: 0.15 });
  if (ref && /\d/.test(ref.value)) put(f, 'reference_number', ref.value, ref);
  if (!f.gross_weight_kg) grossWeight(doc, f, locale);
}

function extractPL(doc: Doc, f: Fields, locale: 'eu' | 'us' | 'auto') {
  const no = anchor(doc, /PACKING\s*LIST\s*(NO|NUMBER|#)\.?|PACKLISTEN-?\s*NUMMER|PACKING\s*SLIP\s*[-–]?|DELIVERY\s*NOTE\s*NO/i, /\b([A-Z0-9][A-Z0-9/-]{3,20})\b/, { below: 2, reject: /^(DATE|PAGE|NO)$/i });
  if (no && /\d/.test(no.value)) put(f, 'document_number', no.value, no);
  else {
    const top = findAll(doc, /\b([A-Z][A-Za-z]{1,5}\/[A-Z]{2,5}\/\d{3,}|[A-Z]{2,4}\/?\d{5,})\b/).find((m) => m.line.page === 1 && m.line.y < 0.15);
    if (top) put(f, 'document_number', top.value, { value: top.value, raw: top.line.text, line: top.line, method: 'right', conf: 0.9 }, { method: 'right' });
  }
  docDate(doc, f, /^DATE|DATUM|DATE\s*OF\s*PACKING|PLACE\s*&\s*DATE/i);
  const cons = block(doc, /^(CONSIGNEE|CUSTOMER(?!\s*(NO|ID|#|PO|PART|SERVICE))|SOLD\s*TO(\s*MESSRS\.?)?|SHIP(PING)?\s*(TO|ADDRESS)|DELIVER\s*TO|BUYER)\b:?/i, { maxLines: 5 });
  if (cons) putParty(f, 'consignee', cons);
  if (!f.consignee || f.consignee.valid !== true) {
    const n = doc.lines.find((l) => l.page === 1 && /NIMR/i.test(l.text));
    if (n) { delete f.consignee; put(f, 'consignee', 'NIMR AUTOMOTIVE LLC', { value: 'NIMR', raw: n.text, line: n, method: 'block', conf: 0.9 }, { method: 'gazetteer', valid: true }); }
  }
  const shp = block(doc, /^(SHIPPER:?|SELLER|EXPORTER|SUPPLIER|VENDOR)\b/i, { maxLines: 5 });
  if (shp) putParty(f, 'shipper', shp);
  if (!f.shipper) {
    const lh = letterhead(doc, [String(f.consignee?.value ?? '')]);
    if (lh) { const m = matchParty(lh.value); put(f, 'shipper', m?.name ?? lh.value, lh, { valid: m ? true : undefined, method: m ? 'gazetteer' : 'block' }); }
  }
  const inv = anchor(doc, /INVOICE\s*(NO|NUMBER|#)\.?|INV\s*(NO)?[:.]|RECHNUNG(S-?NR)?/i, /\b([A-Z0-9][A-Z0-9/-]{3,20})\b/, { below: 2 });
  if (inv && /\d/.test(inv.value)) put(f, 'invoice_number', inv.value, inv);
  const ord = anchor(doc, /ORDER\s*(NO|NUMBER)\.?|SALES\s*ORDER|ORDER-?NO/i, /\b([A-Z0-9][A-Z0-9/-]{3,20})\b/, { below: 2 });
  if (ord && /\d/.test(ord.value)) put(f, 'order_number', fixPrefix(ord.value), ord);
  grossWeight(doc, f, locale); netWeight(doc, f, locale); volume(doc, f, locale); packages(doc, f);
}

function extractCI(doc: Doc, f: Fields, locale: 'eu' | 'us' | 'auto') {
  const no = anchor(doc, /INVOICE\s*(NO|NUMBER|#)\.?|RECHNUNG(S-?NR)?|INV\.?\s*NO/i, /\b([A-Z0-9][A-Z0-9/-]{3,20})\b/, { below: 2 });
  if (no && /\d/.test(no.value)) put(f, 'document_number', no.value, no);
  docDate(doc, f, /INVOICE\s*DATE|^DATE|DATUM/i);
  putParty(f, 'consignee', block(doc, /^(BILL\s*TO|SOLD\s*TO|BUYER|CONSIGNEE|CUSTOMER)\b/i, { maxLines: 5 }));
  const shp = block(doc, /^(SELLER|SHIPPER|EXPORTER|SUPPLIER)\b/i, { maxLines: 5 });
  if (shp) putParty(f, 'shipper', shp);
  if (!f.shipper) { const lh = letterhead(doc, [String(f.consignee?.value ?? '')]); if (lh) put(f, 'shipper', lh.value, lh); }
  const tot = anchor(doc, /TOTAL\s*(AMOUNT|VALUE|INVOICE\s*VALUE|DUE)?|GRAND\s*TOTAL|AMOUNT\s*DUE|GESAMTBETRAG/i, /([A-Z]{3})?\s*(\d[\d.,]*\d)/, { below: 1 });
  if (tot) {
    // a TOTAL row also carries the total quantity ("TOTAL  10  USD 10,157.50"): take the amount with a currency code,
    // else the largest number on the line
    const nums = [...tot.line.text.matchAll(/(USD|EUR|AED|GBP|ZAR|IDR|CNY|INR|JPY|SAR)?\s*(\d[\d.,]*\d|\d)/g)].map((m) => ({ cur: !!m[1], p: parseNumber(m[2], locale) })).filter((x) => x.p);
    const best = nums.find((x) => x.cur) ?? nums.sort((a, b) => b.p!.value - a.p!.value)[0];
    const p = best?.p ?? parseNumber(tot.value, locale);
    if (p) put(f, 'total_amount', p.value, tot, { ambiguous: p.ambiguous });
  }
  const cur = findAll(doc, /\b(USD|EUR|AED|GBP|ZAR|IDR|CNY|INR|JPY|SAR)\b/)[0];
  if (cur) put(f, 'currency', cur.value, { value: cur.value, raw: cur.line.text, line: cur.line, method: 'regex', conf: 0.9 }, { valid: true });
  grossWeight(doc, f, locale); netWeight(doc, f, locale);
}

/**
 * Generic "Caption: value" pass (layout-independent). A KV hit fills a missing field, or replaces a value that
 * is clearly wrong (a caption, or failed validation). It never overrides a validated / gazetteer-confirmed value.
 */
function applyKeyValues(doc: Doc, f: Fields, locale: 'eu' | 'us' | 'auto', docType: DocType) {
  const kvs = [...keyValues(doc), ...captionBelow(doc)];
  const lists: Record<string, Set<string>> = {};
  for (const kv of kvs) {
    const cur = f[kv.field];
    const weak = !cur || cur.valid === false || looksLikeLabel(String(cur.value ?? '')) || (cur.method !== 'gazetteer' && cur.valid !== true && cur.confidence < 0.9);
    const v = kv.value;
    let val: string | number | null = null; let valid: boolean | undefined;
    switch (kv.field) {
      case 'shipper': case 'consignee': case 'notify_party': {
        const ls = v.split('\n');
        const m = matchParty(ls[0]) ?? matchParty(ls.slice(0, 2).join(' '));
        if (/^SAME\s*AS\s*CONSIGNEE/i.test(ls[0])) { val = 'SAME AS CONSIGNEE'; break; }
        val = m?.name ?? ls[0].replace(/\s{2,}/g, ' ').replace(/,\s*$/, ''); valid = m ? true : undefined;
        if (ls.length > 1 && !f[`${kv.field}_address`]) put(f, `${kv.field}_address`, ls.slice(1).join(', '), kv.hit);
        break;
      }
      case 'port_of_loading': case 'port_of_discharge': case 'place_of_receipt': case 'place_of_delivery': {
        val = v; const p = resolvePort(v); if (p) { valid = true; if (!f[`${kv.field}_locode`]) put(f, `${kv.field}_locode`, p.locode, kv.hit, { valid: true }); } break;
      }
      case 'container_numbers': {
        (lists[kv.field] ??= new Set());
        for (const m of v.toUpperCase().matchAll(/[A-Z]{3}[UJZ][\s-]?\d{6}[\s-]?\d?/g)) lists[kv.field].add(fixContainer(m[0]).value);
        continue;
      }
      case 'seal_numbers': { (lists[kv.field] ??= new Set()); for (const t of v.split(/[,;/\s]+/)) if (/^[A-Z0-9-]{5,15}$/i.test(t) && /\d/.test(t)) lists[kv.field].add(t.toUpperCase()); continue; }
      case 'hs_codes': { (lists[kv.field] ??= new Set()); for (const m of v.matchAll(/\d{4}\.?\d{2}\.?\d{0,4}/g)) { const n = normHs(m[0]); if (n) lists[kv.field].add(n); } continue; }
      case 'total_packages': case 'pieces': { const m = v.match(/^\s*(\d[\d,]*)/); if (m) val = Number(m[1].replace(/,/g, '')); break; }
      case 'gross_weight_kg': case 'net_weight_kg': {
        const m = v.match(/(\d[\d.,]*)\s*(KGS?|KG'?S|K|LBS?)?/i); if (!m) break;
        const p = parseNumber(m[1], locale); if (!p) break;
        val = /^L/i.test(m[2] ?? '') ? Math.round(p.value * 0.45359237 * 100) / 100 : p.value; break;
      }
      case 'volume_cbm': { const m = v.match(/(\d[\d.,]*)/); const p = m ? parseNumber(m[1], 'us') : null; if (p) val = p.value; break; }
      case 'total_amount': { const m = v.match(/(\d[\d.,]*\d)/); const p = m ? parseNumber(m[1], locale) : null; if (p) val = p.value; const c = v.match(/\b([A-Z]{3})\b/); if (c && isCurrency(c[1]) && !f.currency) put(f, 'currency', c[1], kv.hit, { valid: true }); break; }
      case 'currency': { const c = v.toUpperCase().match(/\b([A-Z]{3})\b/); if (c && isCurrency(c[1])) { val = c[1]; valid = true; } break; }
      case 'incoterm': { const n = normIncoterm(v); if (n) { val = n; valid = true; } break; }
      case 'country_of_origin': { const c = resolveCountry(v.replace(/\(.*$/, '').trim()); if (c) { val = c; valid = true; } break; }
      case 'document_date': case 'shipped_on_board_date': { const d = pDate(v); if (d) { val = d.iso; valid = true; } break; }
      case 'airport_of_departure': case 'airport_of_destination': { const a = resolveAirport(v); val = a?.iata ?? v; valid = a ? true : undefined; break; }
      case 'mawb_number': { const d = v.replace(/[^0-9]/g, ''); if (d.length === 11) { val = formatAwb(d); valid = validAwb(d); } break; }
      case 'vessel': {
        const m = v.match(/^(.*?[A-Z].*?)(?:\s*[\/(]\s*|\s+V\.?\s*|\s+(?=\S*\d))(V?\.?[0-9][A-Z0-9]{2,9}|[A-Z0-9]{2,9}[0-9][A-Z0-9]*)\)?$/i);
        val = (m ? m[1] : v).trim(); if (m && !f.voyage) put(f, 'voyage', m[2], kv.hit, { method: 'right' }); break;
      }
      case 'voyage': { const m = v.replace(/^V(OY)?\.?\s*/i, '').match(/^([A-Z0-9][A-Z0-9-]{1,12})$/i); if (m) val = m[1]; break; }
      default: { const m = v.match(/^([A-Z0-9][A-Z0-9\/._-]{2,30})/i); if (m && /\d/.test(m[1])) val = m[1]; break; }
    }
    if (val === null || val === '') continue;
    if (kv.field === 'document_number' && docType === 'PACKING_LIST' && /INVOICE/i.test(kv.label)) { if (!f.invoice_number) put(f, 'invoice_number', val, kv.hit); continue; }
    if (!plausible(kv.field, val)) continue;
    if (weak) { delete f[kv.field]; put(f, kv.field, val, kv.hit, { valid, method: kv.hit.method === 'below' ? 'below' : 'right' }); }
  }
  for (const [k, set] of Object.entries(lists)) {
    if (!set.size) continue;
    const cur = f[k];
    const merged = new Set([...(cur ? String(cur.value).split(/,\s*/).filter(Boolean) : []), ...set]);
    const kv = kvs.find((x) => x.field === k)!;
    const valid = k === 'container_numbers' ? [...merged].every((c) => fixContainer(c).valid) : true;
    delete f[k]; put(f, k, [...merged].join(', '), kv.hit, { valid, method: 'right' });
  }
  // document_number fallbacks from captions
  if (!f.document_number) for (const k of ['bl_number', 'invoice_number', 'hawb_number', 'mawb_number']) if (f[k] && (k !== 'invoice_number' || docType === 'COMMERCIAL_INVOICE')) { f.document_number = { ...f[k], method: 'derived' }; break; }
}

/** Drop values that are captions/boilerplate; they are never right and must not be auto-accepted. */
const VESSEL_PREFIXES = ['CMA CGM', 'MAERSK', 'COSCO SHIPPING', 'COSCO', 'HAPAG', 'EVER', 'OOCL', 'WAN HAI', 'HYUNDAI', 'ONE', 'MSC', 'APL', 'HMM', 'ZIM', 'YM'];
const NUMERIC_FIELDS = new Set(['gross_weight_kg', 'net_weight_kg', 'chargeable_weight_kg', 'total_packages', 'pieces', 'volume_cbm', 'total_amount']);
function sanitize(f: Fields) {
  // numbers read from bank / phone lines or zero-padded account digits are not quantities
  for (const k of NUMERIC_FIELDS) {
    const v = f[k];
    if (v && v.method !== 'derived' && (/\b(IBAN|SWIFT|BIC|ACCOUNT|A\/C|TEL|PHONE|FAX|MOBILE)\b/i.test(v.raw ?? '') || /(?<![\d.,])0{2,}[1-9]\d+/.test((v.raw ?? '').replace(/\s+(?=\d)/g, '')) && !/[.,]/.test(String(v.raw)))) delete f[k];
  }
  // an ID that is really an HS code or PO number from a table row
  const hs = new Set(String(f.hs_codes?.value ?? '').split(/,\s*/).filter(Boolean));
  const pos = new Set(String(f.po_numbers?.value ?? '').split(/,\s*/).filter(Boolean));
  for (const k of ['document_number', 'invoice_number', 'bl_number']) {
    const v = f[k];
    if (v && typeof v.value === 'string' && (hs.has(v.value) || (k !== 'invoice_number' && pos.has(v.value) && v.method !== 'derived'))) delete f[k];
  }
  // carrier prefix of a vessel name misread by OCR ("CHA CGM MENDELSSOHN" -> "CMA CGM ...")
  if (f.vessel && typeof f.vessel.value === 'string' && f.vessel.sourceConf !== undefined) {
    const vv = f.vessel.value.toUpperCase();
    for (const pre of VESSEL_PREFIXES) {
      const head = vv.slice(0, pre.length);
      if (head !== pre && head.length === pre.length && /[A-Z]/.test(head[0]) && levenshtein(head, pre) === 1 && (vv[pre.length] === ' ' || vv.length === pre.length) && pre.length >= 5) {
        f.vessel.value = pre + f.vessel.value.slice(pre.length);
        f.vessel.confidence = Math.min(f.vessel.confidence, 0.79);
        (f.vessel.issues ??= []).push(`OCR: carrier prefix corrected from "${head}"`);
        break;
      }
    }
  }
  // vessel and voyage run together by OCR ("APLBARCELONAOPEGAE1MA"): strip a known voyage, else send to review
  const ves = f.vessel;
  if (ves && typeof ves.value === 'string') {
    const voy = String(f.voyage?.value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const sqv = ves.value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/0/g, 'O');
    if (voy.length >= 3 && sqv.endsWith(voy.replace(/0/g, 'O')) && sqv.length > voy.length + 3) ves.value = ves.value.replace(/\s*\S*$/, (m) => m.slice(0, Math.max(0, m.length - voy.length))).trim();
    else if (/\S*[A-Z]{3}\S*\d\S*/i.test(ves.value) && ves.value.split(/\s+/).some((t) => t.length >= 12 && /\d/.test(t))) { ves.confidence = Math.min(ves.confidence, 0.79); (ves.issues ??= []).push('vessel and voyage may be run together'); }
  }
  for (const k of ['bl_number', 'document_number']) {
    const v = f[k]; // carrier prefix (SCAC/ISO owner code) read with a zero: C0SU6030603280 -> COSU6030603280
    if (v && typeof v.value === 'string' && /^[A-Z]{1,2}0[A-Z]{1,2}\d{6,}$/.test(v.value)) v.value = v.value.slice(0, 4).replace(/0/g, 'O') + v.value.slice(4);
  }
  for (const [k, v] of Object.entries(f)) {
    if (typeof v.value !== 'string') continue;
    const s = v.value;
    if (!plausible(k, s)) { delete f[k]; continue; }
    if (looksLikeLabel(s) || (/^(shipper|consignee|notify_party|vessel|port_of_loading|port_of_discharge|place_of_receipt|place_of_delivery)$/.test(k) && /(LOAD,\s*STOWAGE|FREIGHT\s*PREPAID|CLEAN\s*ON\s*BOARD|SHIPPED\s*ON\s*BOARD|SAID\s*TO\s*CONTAIN|^\(|NAME\s*AND\s*ADDRESS)/i.test(s))) delete f[k];
  }
}

export const REQUIRED: Record<DocType, string[]> = {
  BILL_OF_LADING: ['bl_number', 'shipper', 'consignee', 'port_of_loading', 'port_of_discharge', 'gross_weight_kg'],
  TELEX_RELEASE: ['bl_number', 'consignee'],
  AIR_WAYBILL: ['document_number', 'shipper', 'consignee', 'airport_of_departure', 'airport_of_destination', 'pieces', 'gross_weight_kg'],
  PACKING_LIST: ['document_number', 'shipper', 'consignee', 'po_numbers'],
  COMMERCIAL_INVOICE: ['document_number', 'document_date', 'shipper', 'consignee', 'total_amount', 'currency'],
  COURIER_LABEL: [],
  ARRIVAL_NOTICE: [],
  DELIVERY_ORDER: [],
  CERTIFICATE_OF_ORIGIN: [],
  CUSTOMS_DECLARATION: [],
  OTHER: [],
};

export const ACCEPT_THRESHOLD = 0.8;
const CHECKSUMMED = new Set(['mawb_number', 'container_numbers']);
const OCR_ID_FIELDS = new Set(['hs_codes', 'po_numbers', 'bl_number', 'document_number', 'invoice_number', 'hawb_number', 'order_number', 'reference_number', 'voyage', 'flight', 'seal_numbers', 'tracking_number']);

export function extractFields(fileName: string, pages: PageData[], docType: DocType, docTypeConfidence: number, ms: number): Extraction {
  const doc: Doc = { lines: pages.flatMap((p) => p.lines), text: '' };
  doc.text = doc.lines.map((l) => l.text).join('\n');
  const locale = detectLocale(doc.text);
  const head = doc.lines.filter((l) => l.page === 1 && l.y < 0.4).map((l) => l.text).join(' ');
  CTX.dateConv = /UNITED\s*STATES|\bUSA\b|,\s*(FL|NJ|NY|CA|TX|GA|IL)\s*\d{5}|\b(FL|NJ)\s*\d{5}/i.test(head) ? 'US'
    : /SOUTH\s*AFRICA|GERMANY|AUSTRIA|DEUTSCHLAND|INDONESIA|UNITED\s*ARAB|U\.?A\.?E|INDIA|UNITED\s*KINGDOM|\bDE\b\s*$/im.test(head) ? 'DMY' : null;
  const f: Fields = {};
  switch (docType) {
    case 'BILL_OF_LADING': case 'TELEX_RELEASE': extractBL(doc, f, locale); break;
    case 'AIR_WAYBILL': extractAWB(doc, f, locale); break;
    case 'PACKING_LIST': extractPL(doc, f, locale); break;
    case 'COMMERCIAL_INVOICE': extractCI(doc, f, locale); break;
    case 'COURIER_LABEL': {
      const trk = anchor(doc, /TRK\s*#?|TRACKING\s*(NO|NUMBER|#)?|WAYBILL\s*(NO)?/i, /\b(\d{4}\s?\d{4}\s?\d{4}(\s?\d{3})?|\d{10,22})\b/, { below: 2 });
      if (trk) { put(f, 'tracking_number', trk.value.replace(/\s/g, ''), trk); f.document_number = { ...f.tracking_number, method: 'derived' }; }
      const carrierM = findAll(doc, /\b(FEDEX|DHL|UPS|ARAMEX|TNT)\b/i)[0];
      if (carrierM) put(f, 'courier', carrierM.value.toUpperCase(), { value: carrierM.value, raw: carrierM.line.text, line: carrierM.line, method: 'regex', conf: 0.9 });
      break;
    }
    default: break;
  }
  commonIds(doc, f);
  applyKeyValues(doc, f, locale, docType);
  sanitize(f);
  const li = extractLineItems(doc, locale, docType, f);
  const lineItems: LineItem[] = li.lineItems;
  // document HS list = every code printed on an item line, plus header codes ("Tariff Code:" on Radel)
  const lineHs = [...new Set(lineItems.map((x) => x.hs_code).filter((x): x is string => typeof x === 'string' && /^\d{6,10}$/.test(x)))];
  if (lineHs.length) {
    const have = new Set(String(f.hs_codes?.value ?? '').split(/,\s*/).filter(Boolean));
    const add = lineHs.filter((x) => !have.has(x));
    if (add.length) {
      const all = [...have, ...add];
      const minLine = Math.min(...lineItems.filter((x) => x.hs_code).map((x) => x.scores.hs_code ?? 0.8));
      f.hs_codes = { value: all.join(', '), raw: all.join(','), confidence: Math.min(f.hs_codes?.confidence ?? 0.99, minLine), method: 'table', valid: true, page: lineItems[0]?.page };
    }
  }

  const reviewReasons: string[] = [];
  // Calibration: on an unfamiliar layout, only validated values may be auto-accepted.
  if (!['COURIER_LABEL', 'OTHER'].includes(docType) && !isFamiliar(docType, f)) {
    let capped = 0;
    for (const v of Object.values(f)) if (v.valid !== true && v.confidence >= ACCEPT_THRESHOLD) { v.confidence = 0.79; capped++; }
    if (capped) reviewReasons.push(`new sender/layout: ${capped} unvalidated field(s) need review (approving teaches this layout)`);
  }
  // OCR character risk: a familiar layout says WHERE the value is, not that every character was read right.
  // Unvalidated free-form IDs read by OCR go to review when the recogniser was unsure, or when they mix letters and
  // digits next to an O/0 or I/1 (the recogniser's commonest swaps). Checksummed / gazetteer values are exempt.
  {
    let risky = 0;
    // a container list read by OCR may be incomplete: every container-like token in the text must be in the list
    const cn = f.container_numbers;
    if (cn && pages.some((p) => p.source === 'ocr') && cn.confidence >= ACCEPT_THRESHOLD) {
      const listed = new Set(String(cn.value).split(/,\s*/));
      const dig = (x: string) => x.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
      const seen = new Set([...doc.text.toUpperCase().matchAll(/\b([A-Z]{3}[UJZ])\s?([0-9OSIBL]{6})(?=[0-9OSIBL]?\b)/g)].filter((m) => /\d{3}/.test(m[2])).map((m) => m[1] + dig(m[2])));
      const missing = [...seen].filter((x) => ![...listed].some((l) => l.startsWith(x)));
      const WORDN = '(?:ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN)';
      const stated = Math.max(0, ...[...doc.text.toUpperCase().matchAll(new RegExp(`(?:${WORDN}\\s*)?[(\\[{]\\s*(\\d{1,2})\\s*[)\\]}]\\s*(?:X\\s*)?(?:[24][0O]|45)|${WORDN}\\s*[I|1]?(\\d{1,2})[)\\]}]\\s*(?:[24][0O]|45)|\\b(\\d{1,2})\\s*X\\s*(?:[24][0O]|45)\\s*'?\\s*(?:FT|GP|HC|HQ|HD|DV)\\b`, 'g'))].map((m) => Number(m[1] ?? m[2] ?? m[3])));
      if (stated > listed.size) missing.push(`${stated} containers stated, ${listed.size} read`);
      if (missing.length) { cn.confidence = 0.79; risky++; (cn.issues ??= []).push(`OCR: container-like text not in list (${missing.join(', ')})`); }
    }
    for (const [k, v] of Object.entries(f)) {
      // only a checksum proves every character; a gazetteer hit (a valid IATA code) can be a misread of another one
      if (CHECKSUMMED.has(k) && v.valid === true) continue;
      if (v.sourceConf === undefined || v.confidence < ACCEPT_THRESHOLD) continue;
      if (v.valid === true && v.sourceConf >= 0.93) continue;
      const s = typeof v.value === 'string' ? v.value.toUpperCase() : '';
      const confusable = OCR_ID_FIELDS.has(k) && ((/[A-Z]/.test(s) && /\d/.test(s) && /[OI](?=\d)|(?<=\d)[OI]|[01](?=[A-Z])|(?<=[A-Z])[01]/.test(s)) || /^[5S][0O]\d{3,}$/.test(s));
      if (v.sourceConf < (OCR_ID_FIELDS.has(k) || NUMERIC_FIELDS.has(k) ? 0.93 : 0.85) || confusable) { v.confidence = 0.79; risky++; (v.issues ??= []).push(confusable ? 'OCR: O/0 or I/1 ambiguity' : `OCR: low recognition confidence (${v.sourceConf})`); }
    }
    if (risky) reviewReasons.push(`scanned text: ${risky} field(s) with uncertain characters need a check`);
  }
  for (const c of li.checks) if (c.status === 'fail') reviewReasons.push(`${c.check}: ${c.detail}`);
  // Σ line amounts = printed total: the invoice total is confirmed by its own lines
  const amt = li.checks.find((c) => c.check.includes('Σ amount') && c.status === 'pass');
  if (amt && docType === 'COMMERCIAL_INVOICE') {
    const v = Number(amt.detail.match(/total ([\d.]+)/)?.[1]);
    if (Number.isFinite(v)) {
      if (f.total_amount && f.total_amount.value !== v) (f.total_amount.issues ??= []).push(`replaced ${f.total_amount.value}: line amounts add up to ${v}`);
      f.total_amount = { ...(f.total_amount ?? { method: 'table' }), value: v, confidence: 0.97, method: 'table', valid: true } as any;
      reviewReasons.splice(0, reviewReasons.length, ...reviewReasons.filter((r) => !r.includes('total_amount')));
    }
  }
  if (docTypeConfidence < 0.7) reviewReasons.push(`low doc-type confidence (${docTypeConfidence})`);
  for (const k of REQUIRED[docType]) {
    if (!f[k]) reviewReasons.push(`missing ${k}`);
    else if (f[k].confidence < ACCEPT_THRESHOLD) reviewReasons.push(`low confidence ${k} (${f[k].confidence})`);
  }
  for (const [k, v] of Object.entries(f)) if (v.valid === false) reviewReasons.push(`validation failed: ${k}${v.issues ? ' – ' + v.issues.join('; ') : ''}`);
  return {
    fileName, docType, docTypeConfidence, fields: f, lineItems, packages: li.packages, containers: li.containers, lineChecks: li.checks,
    needsReview: reviewReasons.length > 0, reviewReasons,
    pages: pages.map((p) => ({ page: p.page, source: p.source, reason: p.qa.reason, ocrMs: p.ocrMs })),
    ms,
  };
}
