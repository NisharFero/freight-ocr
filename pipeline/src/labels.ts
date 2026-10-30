// Label synonym dictionary + generic "Label: value" key-value pass.
// Layout-independent: works for any document that prints a field caption followed by its value on the same line.
import type { Doc, Hit } from './anchors';
import { levenshtein } from './gazetteer';

/** canonical field -> caption regexes (matched against the whole label segment, colon optional). */
export const LABELS: Record<string, RegExp[]> = {
  bl_number: [/^(B\/?L|BILL\s*OF\s*LADING|HB\/?L|MB\/?L|HBOL|MBOL|BOL|WAYBILL|SEA\s*WAYBILL)\s*(NO\.?|NUMBER|#|REF(ERENCE)?)$/i],
  booking_number: [/^BOOKING\s*(NO\.?|NUMBER|#|REF)$/i],
  shipper: [/^(SHIPPER|CONSIGNOR|EXPORTER|SELLER|SUPPLIER|VENDOR|SOLD\s*BY)(\s*[\/&]\s*(EXPORTER|MERCHANT|SUPPLIER|SELLER|CONSIGNOR))?(\s*NAME)?$/i],
  consignee: [/^(CONSIGNEE|BUYER|SOLD\s*TO|BILL\s*TO|IMPORTER|CUSTOMER|SHIP\s*TO|IMPORTER\s*OF\s*RECORD|CONSIGNED\s*TO(\s*ORDER\s*OF)?)(\s*[\/&]\s*(BILL\s*TO|BUYER|IMPORTER|CONSIGNEE))?(\s*NAME)?$/i],
  notify_party: [/^(NOTIFY(\s*PARTY)?|ALSO\s*NOTIFY)$/i],
  vessel: [/^(OCEAN\s*)?VESSEL(\s*NAME)?$/i, /^(OCEAN\s*)?VESSEL\s*(\/|&|AND)?\s*VOY(AGE)?\.?(\s*NO\.?)?$/i, /^FLIGHT\s*\/\s*VESSEL$/i],
  voyage: [/^VOY(AGE)?\s*(NO\.?|NUMBER|#)?$/i],
  port_of_loading: [/^(PORT\s*OF\s*LOADING|LOADING\s*PORT|POL|PORT\s*OF\s*EXPORT)$/i],
  port_of_discharge: [/^(PORT\s*OF\s*DISCHARGE|DISCHARGE\s*PORT|POD|PORT\s*OF\s*(ENTRY|UNLOADING|ARRIVAL))$/i],
  place_of_receipt: [/^(PLACE\s*OF\s*(RECEIPT|ACCEPTANCE))$/i],
  place_of_delivery: [/^(PLACE\s*OF\s*DELIVERY|FINAL\s*DESTINATION)$/i],
  container_numbers: [/^CONTAINER\s*(NO\.?|NUMBER|#|S)?$/i],
  seal_numbers: [/^SEAL\s*(NO\.?|NUMBER|#|S)?$/i],
  total_packages: [/^(NO\.?\s*OF\s*(PACKAGES|PKGS|PIECES|CARTONS)|TOTAL\s*(PACKAGES|PKGS|CARTONS|PIECES)|PACKAGES|PIECES|QUANTITY\s*OF\s*PACKAGES)$/i],
  gross_weight_kg: [/^(TOTAL\s*)?GROSS\s*(WEIGHT|WT\.?)(\s*\(?KGS?\)?)?$/i],
  net_weight_kg: [/^(TOTAL\s*)?NET\s*(WEIGHT|WT\.?)(\s*\(?KGS?\)?)?$/i],
  volume_cbm: [/^(MEASUREMENT|VOLUME|TOTAL\s*VOLUME|CBM)(\s*\(?(CBM|M3)\)?)?$/i],
  document_number: [/^(INVOICE|PACKING\s*LIST|COMMERCIAL\s*INVOICE)\s*(NO\.?|NUMBER|#)$/i],
  invoice_number: [/^(INVOICE|INV\.?)\s*(NO\.?|NUMBER|#|REF)$/i],
  document_date: [/^(INVOICE\s*DATE|DATE\s*OF\s*ISSUE|ISSUE\s*DATE|DATE|PACKING\s*LIST\s*DATE)$/i],
  shipped_on_board_date: [/^(SHIPPED|LADEN|LOADED)\s*ON\s*BOARD(\s*DATE)?$/i, /^(ETD|DATE\s*OF\s*SHIPMENT|SHIPMENT\s*DATE)$/i],
  incoterm: [/^(INCOTERMS?|TERMS\s*OF\s*(DELIVERY|SALE)|DELIVERY\s*TERMS?|TRADE\s*TERMS?)$/i],
  currency: [/^CURRENCY$/i],
  country_of_origin: [/^(COUNTRY\s*OF\s*(ORIGIN|MANUFACTURE)|ORIGIN)$/i],
  hs_codes: [/^(HS|HTS|HTSUS|TARIFF|COMMODITY|CUSTOMS\s*TARIFF)\s*(CODE|NO\.?|NUMBER|CLASSIFICATION)?S?$/i],
  total_amount: [/^(INVOICE\s*TOTAL|TOTAL\s*(AMOUNT|VALUE|INVOICE\s*VALUE|DUE)?|GRAND\s*TOTAL|AMOUNT\s*DUE|TOTAL\s*INVOICE\s*AMOUNT)$/i],
  airport_of_departure: [/^(AIRPORT\s*OF\s*(DEPARTURE|LOADING)|ORIGIN\s*AIRPORT|DEPARTURE\s*AIRPORT)$/i],
  airport_of_destination: [/^(AIRPORT\s*OF\s*(DESTINATION|DISCHARGE)|DESTINATION\s*AIRPORT)$/i],
  mawb_number: [/^(MAWB|MASTER\s*AWB|MASTER\s*AIR\s*WAYBILL|AWB)\s*(NO\.?|NUMBER|#)?$/i],
  hawb_number: [/^(HAWB|HOUSE\s*AWB|HOUSE\s*AIR\s*WAYBILL)\s*(NO\.?|NUMBER|#)?$/i],
  flight: [/^(FLIGHT(\s*NO\.?|\s*\/\s*DATE)?|REQUESTED\s*FLIGHT(\s*\/\s*DATE)?)$/i],
  order_number: [/^(ORDER|SALES\s*ORDER|PURCHASE\s*ORDER|P\.?O\.?)\s*(NO\.?|NUMBER|#)$/i],
};

const ALL = Object.values(LABELS).flat();

/** Does this text look like a field caption rather than a value? */
const CAPTIONS = ['FINAL DESTINATION', 'PORT OF LOADING', 'PORT OF DISCHARGE', 'PLACE OF RECEIPT', 'PLACE OF DELIVERY', 'OCEAN VESSEL', 'VESSEL NAME',
  'VOYAGE NO', 'NOTIFY PARTY', 'CONSIGNEE', 'SHIPPER', 'EXPORTER', 'PRE CARRIAGE BY', 'FREIGHT PAYABLE AT', 'NUMBER OF ORIGINAL', 'PLACE AND DATE OF ISSUE',
  'DESCRIPTION OF GOODS', 'GROSS WEIGHT', 'MEASUREMENT', 'MARKS AND NUMBERS', 'CONTAINER NO', 'SEAL NO', 'FORWARDING AGENT', 'ALSO NOTIFY',
  'AIRPORT OF DEPARTURE', 'AIRPORT OF DESTINATION', 'ISSUING CARRIER', 'SHIPPED ON BOARD', 'DELIVERY AGENT', 'COUNTRY OF ORIGIN'].map((c) => c.replace(/[^A-Z]/g, ''));

export function looksLikeLabel(v: string): boolean {
  const t = v.trim().replace(/[:：]\s*$/, '');
  if (!t) return true;
  if (/[:：]\s*$/.test(v.trim())) return true;
  if (ALL.some((re) => re.test(t))) return true;
  // OCR-misread captions ("PORT OP LOADING", "C0NSIGNEE") are still captions
  const o = t.toUpperCase().replace(/\bOP\b/g, 'OF').replace(/0/g, 'O').replace(/[1|]/g, 'I').replace(/5/g, 'S');
  if (o !== t.toUpperCase() && ALL.some((re) => re.test(o))) return true;
  // fuzzy match against common captions ("PINAL DESTINATION", "PORT OP LOADING")
  const sq = t.toUpperCase().replace(/[^A-Z]/g, '');
  if (sq.length >= 6 && t.split(/\s+/).length <= 5 && !/\d/.test(t)) {
    for (const c of CAPTIONS) if (Math.abs(c.length - sq.length) <= 2 && levenshtein(sq, c) <= Math.max(1, Math.floor(c.length / 8))) return true;
  }
  return /^(ADDRESS|NAME|SHIPPER\s*ADDRESS|CONSIGNEE\s*ADDRESS|SELLER\s*ADDRESS|BUYER\s*ADDRESS|DESCRIPTION(\s*OF\s*GOODS)?|MARKS(\s*&|\s*AND)?\s*NUMBERS|PARTIES|CARGO|TOTALS|LINE\s*ITEMS)$/i.test(t);
}

export interface KV { field: string; label: string; value: string; hit: Hit }

/**
 * Key-value pairs: a short caption segment (ending in ':' or exactly matching a known caption) immediately followed by a
 * value segment on the same line, or "Caption: value" inside one segment.
 */
export function keyValues(doc: Doc): KV[] {
  const out: KV[] = [];
  for (const line of doc.lines) {
    for (let i = 0; i < line.segments.length; i++) {
      const seg = line.segments[i];
      const txt = seg.text.trim();
      let label: string | null = null; let value: string | null = null; let vseg = seg;
      const m = txt.match(/^([A-Za-z][A-Za-z ./&#()-]{1,40}?)\s*[:：]\s*(.+)$/);
      if (m && matchField(m[1])) { label = m[1]; value = m[2]; }
      else if (matchField(txt.replace(/[:：]\s*$/, '')) && line.segments[i + 1]) {
        const nx = line.segments[i + 1];
        if (!looksLikeLabel(nx.text)) { label = txt.replace(/[:：]\s*$/, ''); value = nx.text; vseg = nx; }
      }
      if (!label || !value) continue;
      const field = matchField(label)!;
      if (looksLikeLabel(value)) continue;
      out.push({ field, label, value: value.trim(), hit: { value: value.trim(), raw: line.text, line, seg: vseg, method: 'right', conf: vseg.conf } });
    }
  }
  return out;
}

export function matchField(label: string): string | null {
  const t = label.trim().replace(/\s+/g, ' ');
  for (const [field, res] of Object.entries(LABELS)) if (res.some((re) => re.test(t))) return field;
  return null;
}

/** Normalise a printed caption: "1. Shipper Insert Name Address and Phone/Fax" -> "Shipper", "Consignee (if 'To Order' so indicate)" -> "Consignee". */
export function normCaption(t: string): string {
  return t.replace(/^\s*\d{1,2}[.)]\s*/, '').replace(/\(.*?\)/g, ' ').replace(/\((.*)$/, ' ')
    .replace(/\b(INSERT\s*)?NAME,?\s*(AND\s*)?(FULL\s*)?ADDRESS(\s*AND\s*PHONE\s*\/?\s*FAX)?\b/gi, ' ')
    .replace(/\bSEE\s*CL(AUSE)?\.?\s*\d+\b/gi, ' ').replace(/[*:：]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Caption-above-value pairs (boxed forms): a segment that is only a caption; the value is the first non-caption text
 * in the following lines inside the caption's column. Party captions return up to 4 lines (name + address).
 */
export function captionBelow(doc: Doc): KV[] {
  const out: KV[] = [];
  const L = doc.lines;
  for (let li = 0; li < L.length; li++) {
    const line = L[li];
    line.segments.forEach((seg, si) => {
      const cap = normCaption(seg.text);
      if (!cap || cap.length > 45) return;
      const field = matchField(cap);
      if (!field) return;
      const next = line.segments[si + 1];
      const col = { x0: seg.x0 - 0.02, x1: next ? Math.max(next.x0 - 0.005, seg.x1) : Math.min(1, seg.x0 + 0.42) };
      const party = field === 'shipper' || field === 'consignee' || field === 'notify_party';
      const got: string[] = []; let first: Hit | null = null;
      for (let lj = li + 1; lj < L.length && lj <= li + (party ? 6 : 3); lj++) {
        const l2 = L[lj];
        if (l2.page !== line.page || l2.y - line.y > 0.12) break;
        const cands = l2.segments.filter((x) => x.x0 >= col.x0 && x.x0 < col.x1);
        if (!cands.length) continue;
        const txt = cands.map((x) => x.text).join(' ').trim();
        const capNext = matchField(normCaption(txt));
        if (capNext || looksLikeLabel(txt)) { if (got.length) break; else continue; }
        if (/non-?\s*negotiable|not\s*negotiable|unless\s*(consigned|marked)|carrier\s*not\s*responsible|no\s*claim\s*shall/i.test(txt)) continue;
        if (!first) first = { value: txt, raw: l2.text, line: l2, seg: cands[0], method: 'below', conf: Math.min(...cands.map((x) => x.conf)) };
        got.push(txt);
        if (!party) break;
      }
      if (first) out.push({ field, label: cap, value: party ? got.join('\n') : got[0], hit: first });
    });
  }
  return out;
}

const BAD_PARTY = /[:@]|www\.|https?:|\b(NEGOTIABLE|CLAUSE|ENDORSEMENT|INCLUDE|NUMBER|INDICATE|INSERT|RESPONSIB|AGENT\(S\)|SEE\s*CL|B\/L\b|BILL\s*OF\s*LADING|WAYBILL\s*NUMBER|INVOICE\s*(NO|NUMBER))/i;
const BAD_PLACE = /\b(AGENT|HANDLING|CHARGES?|ACCOUNT|CLAUSE|PLACE\s*OF|PORT\s*OF|DELIVERY\s*\*|CARRIER|MERCHANT|PARTICULARS|ORIGINALS?|RELEASED)\b|[:*@]/i;

/** Type-level plausibility: values that cannot be right for the field are dropped (and never auto-accepted). */
export function plausible(field: string, v: unknown): boolean {
  if (typeof v !== 'string') return true;
  const s = v.trim();
  if (!s || looksLikeLabel(s)) return false;
  switch (field) {
    case 'shipper': case 'consignee': case 'notify_party': case 'issuing_agent': case 'carrier_or_issuer':
      return /[A-Za-z]{2}/.test(s) && !BAD_PARTY.test(s) && !/^[(\/a-z]/.test(s) && s.length <= 90;
    case 'port_of_loading': case 'port_of_discharge': case 'place_of_receipt': case 'place_of_delivery':
      return /[A-Za-z]{3}/.test(s) && !BAD_PLACE.test(s) && s.length <= 45 && !/\d{4,}/.test(s);
    case 'vessel':
      return /[A-Za-z]{2}/.test(s) && !BAD_PLACE.test(s) && !/^(V\.|VOY)/i.test(s) && s.length <= 40;
    case 'bl_number': case 'document_number': case 'invoice_number': case 'hawb_number': case 'order_number':
      return /\d/.test(s) && /^[A-Z0-9][A-Z0-9\/._-]{3,30}$/i.test(s);
    default: return true;
  }
}
