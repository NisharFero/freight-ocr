// Unit tests (layer 1 of the test strategy): validators and splitter rules. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validAwb, formatAwb, validContainer, fixContainer, normIncoterm, normHs, parseNumber, parseDate } from '../src/validators';
import { splitPages } from '../src/split';
import type { PageData } from '../src/types';

test('AWB mod-7 check digit', () => {
  assert.equal(validAwb('176-67009386'), true);
  assert.equal(validAwb('176-67009387'), false);
  assert.equal(formatAwb('17667009386'), '176-67009386');
});

test('ISO 6346 container check digit + OCR repair', () => {
  assert.equal(validContainer('MSDU1350467'), true);
  assert.equal(validContainer('MSDU1350468'), false);
  const r = fixContainer('MSDU135O467');
  assert.equal(r.value, 'MSDU1350467');
  assert.equal(r.valid, true);
});

test('Incoterms and HS codes', () => {
  assert.equal(normIncoterm('FCA Durban'), 'FCA');
  assert.equal(normIncoterm('ex works'), 'EXW');
  assert.equal(normHs('4016.99.90'), '40169990');
});

test('EU / US number parsing', () => {
  assert.equal(parseNumber('1.234,56', 'eu')?.value, 1234.56);
  assert.equal(parseNumber('1,234.56', 'us')?.value, 1234.56);
  assert.equal(parseNumber('25.115,32')?.value, 25115.32);
  assert.equal(parseNumber('7,168')?.ambiguous, true); // 7168 or 7.168 — must not auto-accept
});

test('dates', () => {
  assert.equal(parseDate('28-Apr-2026')?.iso, '2026-04-28');
  assert.equal(parseDate('2026-05-02')?.iso, '2026-05-02');
  assert.equal(parseDate('05/02/2026', true)?.iso, '2026-05-02');
});

const page = (n: number, title: string, body = ''): PageData => ({
  page: n, width: 595, height: 842, source: 'text-layer', qa: { chars: 500, garbageRatio: 0, hasFullPageImage: false, reason: '' },
  lines: [
    { page: n, y: 0.05, text: title, segments: [{ text: title, x0: 0.1, y0: 0.04, x1: 0.6, y1: 0.06, conf: 1 }] },
    { page: n, y: 0.5, text: body, segments: [{ text: body, x0: 0.1, y0: 0.49, x1: 0.6, y1: 0.51, conf: 1 }] },
  ],
});

test('splitter: BL + invoice + packing list in one PDF -> 3 docs', () => {
  const g = splitPages([
    page(1, 'BILL OF LADING', 'PORT OF LOADING DURBAN PORT OF DISCHARGE JEBEL ALI VESSEL MSC NOTIFY PARTY'),
    page(2, 'COMMERCIAL INVOICE', 'UNIT PRICE TOTAL AMOUNT USD'),
    page(3, 'PACKING LIST', 'NET WEIGHT GROSS WEIGHT PACKAGING DETAILS'),
  ]);
  assert.deepEqual(g.map((x) => x.range), [[1, 1], [2, 2], [3, 3]]);
});

test('splitter: AWB copies and continuation pages stay one doc', () => {
  const awb = 'AIR WAYBILL  AIRPORT OF DEPARTURE  AIRPORT OF DESTINATION';
  assert.equal(splitPages([page(1, awb, 'IATA'), page(2, awb, 'IATA'), page(3, awb, 'IATA')]).length, 1);
  assert.equal(splitPages([page(1, 'PACKING LIST  Page 1 of 2', 'NET WEIGHT'), page(2, 'PACKING LIST  Page 2 of 2', 'NET WEIGHT')]).length, 1);
});

test('splitter: two packing lists with different numbers -> 2 docs', () => {
  const g = splitPages([page(1, 'PACKING LIST No: OUT-02832', 'NET WEIGHT PALLET'), page(2, 'PACKING LIST No: OUT-02855', 'NET WEIGHT PALLET')]);
  assert.equal(g.length, 2);
});

test('splitter: unlabelled header references (Proj/OUT/02832 vs 02855) -> 2 docs', () => {
  const pl = (n: number, ref: string): PageData => { const p = page(n, 'PACKING LIST', 'NET WEIGHT PALLET'); p.lines.unshift({ page: n, y: 0.06, text: ref, segments: [{ text: ref, x0: 0.76, y0: 0.05, x1: 0.96, y1: 0.07, conf: 1 }] }); p.lines[1].y = 0.13; return p; };
  assert.equal(splitPages([pl(1, 'Proj/OUT/02832'), pl(2, 'Proj/OUT/02855')]).length, 2);
});

import { looksLikeLabel } from '../src/labels';
test('OCR-misread captions are rejected as values', () => {
  assert.equal(looksLikeLabel('PINAL DESTINATION'), true);
  assert.equal(looksLikeLabel('PORT OP LOADING'), true);
  assert.equal(looksLikeLabel('CMA CGM MENDELSSOHN'), false);
  assert.equal(looksLikeLabel('JEBEL ALI'), false);
});
