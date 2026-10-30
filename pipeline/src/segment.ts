// Space recovery for OCR output. The bundled PP-OCRv4 (Chinese-dictionary) recogniser often drops spaces
// in Latin text: "NIMRAUTOMOTIVELLC" -> "NIMR AUTOMOTIVE LLC". We re-segment long alphabetic runs with a
// dictionary + domain gazetteer (DP, fewest/longest words), and only accept a split made entirely of known words.
// Not needed if OCR_MODEL_DIR points at an English/Latin PP-OCRv5 recogniser.

import { createRequire } from 'node:module';
import { DOMAIN_WORDS, PORTS } from './gazetteer';
const require = createRequire(import.meta.url);

let DICT: Set<string> | null = null;
const COMMON = new Set('same as of the and to for on by in at with from name address full port place number date total weight gross net order packing list invoice customer country origin code delivery terms shipper consignee notify party carrier agent account goods description quantity container seal vessel voyage loading discharge receipt issue freight charges prepaid collect not negotiable copy original page bank all any may other road unless specific contrary instructions are given hereon shipper agrees that shipment carried via intermediate stopping places which deems appropriate attention drawn notice concerning limitation liability is industrial park road arab united emirates street floor house air waybill issued unit ave'.split(' '));
const TWO_LETTER = new Set(['of', 'to', 'in', 'on', 'at', 'by', 'or', 'as', 'is', 'no', 'an', 'be', 'we', 'it', 'if', 'up', 'so', 'do', 'nw', 'ne', 'sw', 'se', 'co', 'po', 'ab', 'de', 'ae', 'us', 'uk', 'kg', 'cm', 'mm', 'pc', 'nj', 'fl']);

export async function loadDict(): Promise<Set<string>> {
  if (DICT) return DICT;
  const words: string[] = require('an-array-of-english-words/index.json');
  DICT = new Set();
  for (const w of words) if (w.length >= 3 || (w.length === 1 && (w === 'a')) ) DICT.add(w);
  for (const w of TWO_LETTER) DICT.add(w);
  for (const w of DOMAIN_WORDS) DICT.add(w.toLowerCase());
  // place names must survive as one word ("SINGAPORE", not "SIN GAP ORE")
  const place = (s: string) => { for (const t of s.toLowerCase().split(/[^a-z]+/)) if (t.length >= 4) DICT!.add(t); };
  for (const names of Object.values(PORTS)) for (const n of names) place(n);
  return DICT;
}

function segmentRun(run: string, dict: Set<string>): string | null {
  const s = run.toLowerCase();
  const n = s.length;
  const best: { cost: number; prev: number }[] = Array(n + 1).fill(null).map(() => ({ cost: Infinity, prev: -1 }));
  best[0].cost = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(0, i - 24); j < i; j++) {
      if (best[j].cost === Infinity) continue;
      const w = s.slice(j, i);
      if (!dict.has(w)) continue;
      const c = best[j].cost + 1 + (w.length <= 2 ? 0.8 : 0) + (DOMAIN_WORDS.has(w.toUpperCase()) ? -0.3 : 0) + (COMMON.has(w) ? -0.45 : 0);
      if (c < best[i].cost) best[i] = { cost: c, prev: j };
    }
  }
  if (best[n].cost === Infinity) return null;
  const parts: string[] = [];
  for (let i = n; i > 0; i = best[i].prev) parts.unshift(run.slice(best[i].prev, i));
  if (parts.length === 1) return run;
  const avg = n / parts.length;
  if (avg < 3) return null;
  return parts.join(' ');
}

/** Re-insert missing spaces in OCR text. Leaves codes (letters+digits mixed) untouched. */
export function recoverSpaces(text: string, dict: Set<string>): string {
  return text.replace(/[A-Za-z]{9,}/g, (run) => {
    // Codes such as HFAE26005685 never reach here (digits break the run). Skip mixed-case words that look fine.
    if (dict.has(run.toLowerCase())) return run;
    return segmentRun(run, dict) ?? run;
  }).replace(/([a-z])\.([A-Z]{2,})/g, '$1. $2');
}
