// Document-type classifier: weighted keyword scoring, title zone (top 35% of page 1) counts double.
// Deterministic, explainable, zero training. Swap for TF-IDF+LR / GLiNER2 head once labelled data exists.
import type { DocType, PageData } from './types';

const RULES: Record<Exclude<DocType, 'OTHER'>, [RegExp, number][]> = {
  BILL_OF_LADING: [
    [/BILL\s*OF\s*LADING|\bB\s*\/\s*L\s*NO|\bHBOL\b|\bFBL\b|SEA\s*WAYBILL/i, 5],
    [/OCEAN\s*VESSEL|\bVESSEL\b/i, 2], [/PORT\s*OF\s*LOADING/i, 2], [/PORT\s*OF\s*DISCHARGE/i, 2],
    [/NOTIFY\s*(PARTY|ADDRESS)/i, 1.5], [/SHIPPED\s*ON\s*BOARD|LADEN\s*ON\s*BOARD/i, 1.5], [/CONTAINER/i, 1],
  ],
  TELEX_RELEASE: [[/TELEX\s*RELEASE[D]?|SURRENDERED|EXPRESS\s*RELEASE/i, 6]],
  AIR_WAYBILL: [
    [/AIR\s*WAYBILL|AIRWAYBILL|\bHAWB\b|\bMAWB\b/i, 5], [/AIRPORT\s*OF\s*DEPARTURE/i, 3], [/AIRPORT\s*OF\s*DESTINATION/i, 3],
    [/IATA/i, 1.5], [/CHARGEABLE\s*WEIGHT|RATE\s*CLASS/i, 2], [/ISSUING\s*CARRIER/i, 2],
  ],
  PACKING_LIST: [
    [/PACKING\s*LIST|PACKLISTE|PACKING\s*SLIP|PACKLISTEN/i, 6], [/NET\s*(W(EIGH)?T|KG)|NETTO|NET\s*KG/i, 1.5],
    [/GROSS\s*(W(EIGH)?T|KG)|BRUTTO/i, 1], [/DIMENSIONS?|MASSE\s*\(CM\)|PALLET/i, 1.5], [/PACKAGING\s*DETAILS|NO\.?\s*&\s*KIND/i, 1.5],
  ],
  COMMERCIAL_INVOICE: [
    [/COMMERCIAL\s*INVOICE|TAX\s*INVOICE|\bINVOICE\b|RECHNUNG|PROFORMA/i, 4], [/UNIT\s*PRICE|EINZELPREIS/i, 2.5],
    [/TOTAL\s*(AMOUNT|VALUE|INVOICE)|AMOUNT\s*DUE|GESAMTBETRAG/i, 2.5], [/\bVAT\b|\bTRN\b|MWST|UST/i, 1], [/BANK|IBAN|SWIFT/i, 0.5],
  ],
  ARRIVAL_NOTICE: [[/ARRIVAL\s*NOTICE|NOTICE\s*OF\s*ARRIVAL|CARGO\s*ARRIVAL/i, 7], [/\bETA\b|LAST\s*FREE\s*DAY|FIRMS\s*CODE/i, 1.5]],
  DELIVERY_ORDER: [[/DELIVERY\s*ORDER|RELEASE\s*ORDER|\bD\/O\s*NO/i, 7], [/PICK\s*-?\s*UP|RELEASE\s*TO|TRUCKER/i, 1.5]],
  CERTIFICATE_OF_ORIGIN: [[/CERTIFICATE\s*OF\s*ORIGIN|ORIGIN\s*CERTIFICATE|FORM\s*A\b|EUR\.?\s*1/i, 7]],
  CUSTOMS_DECLARATION: [[/ENTRY\s*SUMMARY|CBP\s*FORM|CUSTOMS\s*(DECLARATION|ENTRY)|BILL\s*OF\s*ENTRY|IMPORTER\s*SECURITY\s*FILING|\bISF\b|\bSAD\b|IMPORT\s*DECLARATION/i, 7]],
  COURIER_LABEL: [[/FEDEX|\bDHL\b|\bUPS\b|ARAMEX|TRACKING\s*(NO|NUMBER|#)|\bTRK#/i, 4], [/SHIP\s*DATE|ACTWGT|BILL\s*SENDER/i, 3]],
};

export function classify(pages: PageData[]): { docType: DocType; confidence: number; scores: Record<string, number> } {
  const scores: Record<string, number> = {};
  const p1 = pages[0];
  const title = p1 ? p1.lines.filter((l) => l.y < 0.35).map((l) => l.text).join('\n') : '';
  const titleLines = p1 ? p1.lines.filter((l) => l.y < 0.16).map((l) => l.text).join('\n') : '';
  const body = pages.slice(0, 3).map((p) => p.lines.map((l) => l.text).join('\n')).join('\n');
  for (const [type, rules] of Object.entries(RULES)) {
    let s = 0;
    for (const [re, w] of rules) {
      if (re.test(titleLines) && w >= 5) s += w * 3; else if (re.test(title)) s += w * 2; else if (re.test(body)) s += w;
    }
    scores[type] = s;
  }
  // "INVOICE" appears in packing lists ("Invoice No.") – only a strong title hit makes it an invoice.
  if (scores.PACKING_LIST >= 12 && !/COMMERCIAL\s*INVOICE|TAX\s*INVOICE/i.test(title)) scores.COMMERCIAL_INVOICE *= 0.4;
  // AWB pages mention "carrier"/"consignee" like BLs; airport fields are decisive.
  if (scores.AIR_WAYBILL >= 10) scores.BILL_OF_LADING *= 0.5;
  // A telex release stamp on a BL: keep the BL schema, but flag type TELEX_RELEASE only if it is mostly a release notice.
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  let [best, bestScore] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  if (best === 'TELEX_RELEASE' && scores.BILL_OF_LADING >= 8) { best = 'BILL_OF_LADING'; bestScore = scores.BILL_OF_LADING; }
  if (bestScore < 4) return { docType: 'OTHER', confidence: 0.3, scores };
  const confidence = Math.min(0.99, 0.5 + (bestScore - second) / (bestScore + 1) * 0.5 + Math.min(bestScore, 20) / 80);
  return { docType: best as DocType, confidence: Number(confidence.toFixed(2)), scores };
}
