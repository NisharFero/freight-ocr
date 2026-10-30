import type { Line, Segment } from './types';
import type { RawBox } from './ocr';

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/**
 * Group raw word/run boxes into reading-order lines, and split each line into
 * segments wherever the horizontal gap is large (column / label-value boundary).
 * `aspect` = page width / page height, so gaps can be compared to text height.
 */
export function buildLines(boxes: RawBox[], page: number, aspect: number, mergeGap = 1.6): Line[] {
  const bs = boxes.filter((b) => b.text.trim()).map((b) => ({ ...b, yc: (b.y0 + b.y1) / 2, h: b.y1 - b.y0 }));
  bs.sort((a, b) => a.yc - b.yc || a.x0 - b.x0);
  const medH = median(bs.map((b) => b.h)) || 0.01;

  const rows: (typeof bs)[] = [];
  for (const b of bs) {
    const tol = Math.max(Math.min(b.h, medH * 1.5) * 0.5, medH * 0.3);
    let best: (typeof bs) | null = null; let bestD = Infinity;
    for (let i = rows.length - 1; i >= 0 && i >= rows.length - 4; i--) {
      const r = rows[i];
      const ryc = r.reduce((s, x) => s + x.yc, 0) / r.length;
      const d = Math.abs(ryc - b.yc);
      // must not horizontally overlap an existing box of the row
      const overlaps = r.some((x) => Math.min(x.x1, b.x1) - Math.max(x.x0, b.x0) > 0.3 * Math.min(x.x1 - x.x0, b.x1 - b.x0));
      if (d < tol && d < bestD && !overlaps) { best = r; bestD = d; }
    }
    if (best) best.push(b); else rows.push([b]);
  }

  const lines: Line[] = rows.map((r) => {
    r.sort((a, b) => a.x0 - b.x0);
    const segs: Segment[] = [];
    for (const b of r) {
      const last = segs[segs.length - 1];
      const hW = Math.max(b.h, medH) / aspect; // text height in width-units
      const gap = last ? b.x0 - last.x1 : Infinity;
      if (last && gap < hW * mergeGap) {
        const sep = gap > hW * 0.12 && !last.text.endsWith(' ') && !b.text.startsWith(' ') ? ' ' : '';
        last.text = (last.text + sep + b.text).replace(/\s+/g, ' ');
        last.x1 = Math.max(last.x1, b.x1); last.y0 = Math.min(last.y0, b.y0); last.y1 = Math.max(last.y1, b.y1);
        last.conf = Math.min(last.conf, b.conf);
      } else {
        segs.push({ text: b.text.replace(/\s+/g, ' '), x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, conf: b.conf });
      }
    }
    for (const s of segs) s.text = s.text.trim();
    const kept = segs.filter((s) => s.text);
    return { page, y: r.reduce((s, x) => s + x.yc, 0) / r.length, segments: kept, text: kept.map((s) => s.text).join('  ') };
  });
  return lines.filter((l) => l.segments.length).sort((a, b) => a.y - b.y);
}
