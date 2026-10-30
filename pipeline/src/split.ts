// Multi-document PDF splitter. Users sometimes scan a whole shipment (BL + invoice + packing list) into one PDF.
// A page starts a new document when its title zone names a different doc type, or the same type with a different
// document number. Copies of the same doc (AWB originals 1-3, duplicated pages) stay together.
import type { DocType, PageData } from './types';
import { classify } from './classify';

const GROUP: Partial<Record<DocType, string>> = { TELEX_RELEASE: 'BILL_OF_LADING' };
const grp = (t: DocType) => GROUP[t] ?? t;

const TITLE: [DocType, RegExp][] = [
  ['BILL_OF_LADING', /BILL\s*OF\s*LADING|SEA\s*WAYBILL|\bB\/L\b/i],
  ['AIR_WAYBILL', /AIR\s*WAYBILL|AIRWAYBILL|\bHAWB\b|\bMAWB\b/i],
  ['PACKING_LIST', /PACKING\s*(LIST|SLIP)|PACKLISTE/i],
  ['COMMERCIAL_INVOICE', /COMMERCIAL\s*INVOICE|TAX\s*INVOICE|^\s*INVOICE\b|PROFORMA|RECHNUNG/i],
  ['TELEX_RELEASE', /TELEX\s*RELEASE|SURRENDER/i],
  ['CERTIFICATE_OF_ORIGIN', /CERTIFICATE\s*OF\s*ORIGIN/i],
  ['ARRIVAL_NOTICE', /ARRIVAL\s*NOTICE/i],
  ['DELIVERY_ORDER', /DELIVERY\s*ORDER/i],
];

/** Doc type named in the page's title zone (top 22%), or null if the page has no title (a continuation page). */
function titleType(p: PageData): DocType | null {
  const top = p.lines.filter((l) => l.y < 0.22).map((l) => l.text).join('\n');
  for (const [t, re] of TITLE) if (re.test(top)) return t;
  return null;
}

const NUM_LABEL = /(?:INVOICE|PACKING\s*LIST|DELIVERY\s*NOTE|B\/L|BL|WAYBILL|DOCUMENT|PL)\s*(?:NO|NUMBER|NR|#)\.?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/i;
function docNumber(p: PageData): string | null {
  for (const l of p.lines.filter((l) => l.y < 0.4)) { const m = NUM_LABEL.exec(l.text); if (m && /\d/.test(m[1])) return m[1].toUpperCase(); }
  // unlabelled reference printed in the header, e.g. "Proj/OUT/02832"
  for (const l of p.lines.filter((l) => l.y < 0.12)) { const m = /\b([A-Z][A-Za-z]{1,5}\/[A-Z]{2,5}\/\d{3,})\b/.exec(l.text); if (m) return m[1].toUpperCase(); }
  return null;
}
const PAGE_N = /\bPAGE\s*(\d+)\s*(?:OF|\/)\s*(\d+)|\bSEITE\s*(\d+)\s*(?:VON|\/)\s*(\d+)/i;
function pageOf(p: PageData): number | null {
  const m = PAGE_N.exec(p.lines.map((l) => l.text).join('\n'));
  return m ? Number(m[1] ?? m[3]) : null;
}

export interface PageGroup { pages: PageData[]; range: [number, number] }

export function splitPages(pages: PageData[]): PageGroup[] {
  if (pages.length < 2) return [{ pages, range: [1, Math.max(1, pages.length)] }];
  const groups: PageData[][] = [[pages[0]]];
  let curType: DocType | null = titleType(pages[0]) ?? classify([pages[0]]).docType;
  let curNum = docNumber(pages[0]);
  for (const p of pages.slice(1)) {
    const t = titleType(p);
    const n = docNumber(p);
    const pn = pageOf(p);
    const continuation = pn !== null && pn > 1;
    let start = false;
    if (!continuation && t) {
      if (!curType || grp(t) !== grp(curType)) start = classify([p]).docType !== 'OTHER' && grp(classify([p]).docType) === grp(t);
      else if (n && curNum && n !== curNum && grp(t) !== 'AIR_WAYBILL') start = true; // e.g. 2 packing lists
    }
    if (start) { groups.push([p]); curType = t; curNum = n; }
    else { groups[groups.length - 1].push(p); curNum ??= n; curType ??= t; }
  }
  return groups.map((g) => ({ pages: g, range: [g[0].page, g[g.length - 1].page] as [number, number] }));
}

/** Pages of a split-off document renumbered 1..n so extractors' "page 1" logic still holds. */
export function renumber(g: PageGroup): PageData[] {
  const off = g.range[0] - 1;
  if (!off) return g.pages;
  return g.pages.map((p) => ({ ...p, page: p.page - off, lines: p.lines.map((l) => ({ ...l, page: l.page - off })) }));
}
