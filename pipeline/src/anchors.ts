// Label-anchored extraction helpers over positioned lines.
import type { Line, Segment } from './types';

export interface Doc {
  lines: Line[]; // all pages, in reading order
  text: string;
}

export interface Hit {
  value: string;
  raw: string;
  line: Line;
  seg?: Segment;
  method: 'same-segment' | 'right' | 'below' | 'regex' | 'block' | 'derived';
  conf: number; // OCR/text confidence of the source
}

/** Labels that end a multi-line block (another form box starts). */
export const STOP_LABELS = /^(SHIPPER|CONSIGNOR|CONSIGNEE|CONSIGNED\s*TO|NOTIFY|PRE-?\s*CARRIAGE|PLACE\s*OF|PORT\s*OF|VESSEL|OCEAN\s*VESSEL|ISSUING|AGENT'?S|AIRPORT|ACCOUNTING|REFERENCE|FOR\s*DELIVERY|DELIVERY\s*AGENT|MARKS|CONTAINER|ALSO\s*NOTIFY|ISSUED\s*BY|COPIES|IT\s*IS\s*AGREED|SOLD\s*TO|SHIP\s*TO|BILL\s*TO|SHIPPING\s*ADDRESS|DATE|INVOICE|ORDER|CUSTOMER\s*(ID|NO)|DELIVERY\s*TERM|YOUR\s*REF|PACKING|PAGE\s*\d|TEL[:.]|PHONE|HANDLING|PARTICULARS|NUMBER\s*OF|FREIGHT|SALES\s*ORDER)/i;

const xOverlap = (a: { x0: number; x1: number }, b: { x0: number; x1: number }) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);

/** x-range of characters [a,b) inside a segment, assuming proportional character widths. */
export function subRange(seg: Segment, a: number, b: number): { x0: number; x1: number } {
  const n = Math.max(seg.text.length, 1), w = seg.x1 - seg.x0;
  return { x0: seg.x0 + (w * a) / n, x1: seg.x0 + (w * b) / n };
}

/** Text of a segment that falls inside [x0,x1] (proportional char positions), expanded to whole words. */
export function sliceByX(seg: Segment, x0: number, x1: number): string {
  if (seg.x0 >= x0 - 0.005 && seg.x1 <= x1 + 0.005) return seg.text;
  const n = seg.text.length, w = seg.x1 - seg.x0;
  const words = [...seg.text.matchAll(/\S+/g)];
  const keep = words.filter((m) => {
    const c = seg.x0 + (w * (m.index! + m[0].length / 2)) / n;
    return c >= x0 && c <= x1;
  });
  return keep.map((m) => m[0]).join(' ');
}

function strip(s: string) {
  return s.replace(/^[\s:.;#\-–=|)(]+/, '').replace(/[\s:;|]+$/, '').trim();
}

/**
 * Find `label`, then look for `value` (regex, first capture group or whole match) in:
 *  1) the rest of the same segment, 2) segments to the right on the same line, 3) the lines below in the label's column.
 */
export function anchor(doc: Doc, label: RegExp, value: RegExp, opts: { below?: number; right?: boolean; pages?: number[]; colWidth?: number; reject?: RegExp; accept?: (v: string) => boolean; all?: boolean } = {}): Hit | null {
  const below = opts.below ?? 3;
  const colW = opts.colWidth ?? 0.3;
  const lines = opts.pages ? doc.lines.filter((l) => opts.pages!.includes(l.page)) : doc.lines;
  const pick = (s: string): string | null => {
    const m = s.match(value);
    if (!m) return null;
    const v = (m[1] ?? m[0]).trim();
    // an ID cut out of a decimal amount ("106175" from "106175.02") is not an ID
    const tail = s.slice((m.index ?? 0) + m[0].length);
    if (/^\d{5,}$/.test(v) && /^[.,]\d{1,3}\b/.test(tail)) return null;
    if (opts.reject && opts.reject.test(v)) return null;
    if (opts.accept && !opts.accept(v)) return null;
    return v;
  };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (let si = 0; si < line.segments.length; si++) {
      const seg = line.segments[si];
      const lm = seg.text.match(label);
      if (!lm) continue;
      const rest = strip(seg.text.slice((lm.index ?? 0) + lm[0].length));
      const v1 = rest ? pick(rest) : null;
      if (v1) return { value: v1, raw: seg.text, line, seg, method: 'same-segment', conf: seg.conf };
      if (opts.right !== false) {
        for (let sj = si + 1; sj < Math.min(line.segments.length, si + 3); sj++) {
          const v2 = pick(strip(line.segments[sj].text));
          if (v2) return { value: v2, raw: line.segments[sj].text, line, seg: line.segments[sj], method: 'right', conf: line.segments[sj].conf };
        }
      }
      // Column of the label. If the label sits inside a wider merged segment, use its proportional sub-range,
      // ending where the next header word starts.
      const li0 = lm.index ?? 0, li1 = li0 + lm[0].length;
      const merged = seg.text.length > lm[0].length + 6;
      const lr = merged ? subRange(seg, li0, li1) : { x0: seg.x0, x1: seg.x1 };
      let x1 = Math.max(lr.x1, lr.x0 + colW);
      if (merged) {
        const nxt = seg.text.slice(li1).search(/\S{2,}/);
        if (nxt >= 0) x1 = Math.min(x1, subRange(seg, li1 + nxt, li1 + nxt + 1).x0 - 0.002);
        x1 = Math.max(x1, lr.x1);
      }
      const nextSeg = line.segments[si + 1];
      if (nextSeg && nextSeg.x0 > lr.x1) x1 = Math.min(x1, Math.max(nextSeg.x0 - 0.002, lr.x1));
      const col = { x0: lr.x0 - 0.02, x1 };
      let seen = 0;
      for (let lj = li + 1; lj < lines.length && seen < below; lj++) {
        const l2 = lines[lj];
        if (l2.page !== line.page) break;
        const cands = l2.segments.filter((s) => xOverlap(s, col) > 0);
        if (!cands.length) continue;
        seen++;
        for (const s of cands) {
          const txt = sliceByX(s, col.x0 - 0.01, col.x1 + 0.01);
          const v3 = txt ? pick(strip(txt)) : null;
          if (v3) return { value: v3, raw: s.text, line: l2, seg: s, method: 'below', conf: s.conf };
        }
      }
    }
  }
  return null;
}

/** Multi-line block (address box) under a label, constrained to the label's column. */
export function block(doc: Doc, label: RegExp, opts: { maxLines?: number; colWidth?: number; pages?: number[] } = {}): Hit | null {
  const maxLines = opts.maxLines ?? 6;
  const colW = opts.colWidth ?? 0.42;
  const lines = opts.pages ? doc.lines.filter((l) => opts.pages!.includes(l.page)) : doc.lines;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (const seg of line.segments) {
      const lm = seg.text.match(label);
      if (!lm || (lm.index ?? 0) > 3) continue;
      const out: string[] = [];
      let conf = 1;
      const rest = strip(seg.text.slice((lm.index ?? 0) + lm[0].length).replace(/^\(.*?\)/, ''));
      if (rest && rest.length > 3 && !/name|address|account|negotiable|order\)|carrier not/i.test(rest)) out.push(rest);
      // Column: from label's x0 to the next segment on the label line (or colW)
      const nextSeg = line.segments.find((s) => s.x0 > seg.x1 + 0.01);
      const col = { x0: seg.x0 - 0.03, x1: nextSeg ? Math.max(nextSeg.x0 - 0.005, seg.x0 + 0.15) : seg.x0 + colW };
      let lastY = line.y;
      for (let lj = li + 1; lj < lines.length && out.length < maxLines; lj++) {
        const l2 = lines[lj];
        if (l2.page !== line.page) break;
        if (l2.y - lastY > 0.05) break; // big vertical gap ends the box
        const cands = l2.segments.filter((s) => s.x0 >= col.x0 && s.x0 < col.x1);
        if (!cands.length) continue;
        const t = cands.map((s) => (s.x1 > col.x1 + 0.05 ? sliceByX(s, col.x0, col.x1) : s.text)).join(' ').trim();
        if (!t) continue;
        if (STOP_LABELS.test(t) && out.length) break;
        if (STOP_LABELS.test(t)) continue;
        if (/name\s*and\s*(full\s*)?address|account\s*number|carrier not responsible|non-?\s*negotiable|consigned\s*"?to\s*order/i.test(t)) continue;
        out.push(t);
        conf = Math.min(conf, ...cands.map((s) => s.conf));
        lastY = l2.y;
      }
      if (out.length) return { value: out.join('\n'), raw: out.join('\n'), line, seg, method: 'block', conf };
    }
  }
  return null;
}

/** All regex matches over the document, with their lines. */
export function findAll(doc: Doc, re: RegExp): { value: string; line: Line }[] {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const out: { value: string; line: Line }[] = [];
  for (const l of doc.lines) {
    // search both the segment-joined text and the squashed text (OCR may split a code across segments)
    for (const m of l.text.matchAll(g)) out.push({ value: (m[1] ?? m[0]).trim(), line: l });
  }
  return out;
}

export function bboxOf(h: Hit | null): [number, number, number, number] | undefined {
  if (!h) return undefined;
  const s = h.seg ?? h.line.segments[0];
  return s ? [s.x0, s.y0, s.x1, s.y1] : undefined;
}
