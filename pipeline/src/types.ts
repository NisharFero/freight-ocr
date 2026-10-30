// Shared types for the freight document pipeline.
// All coordinates are normalised to the page: 0..1 (x to the right, y downwards).

export interface Segment {
  text: string;
  x0: number; y0: number; x1: number; y1: number;
  conf: number; // 0..1 (1 for born-digital text)
}

export interface Line {
  page: number;
  y: number; // centre y
  segments: Segment[]; // left -> right, split on big horizontal gaps (table cells / label-value columns)
  text: string; // segments joined with single spaces
}

export type PageSource = 'text-layer' | 'ocr';

export interface PageData {
  page: number; // 1-based
  width: number; // pt (pdf) or px (image)
  height: number;
  source: PageSource;
  qa: { chars: number; garbageRatio: number; hasFullPageImage: boolean; reason: string };
  lines: Line[];
  ocrMs?: number;
}

export interface IngestResult {
  fileName: string;
  pages: PageData[];
  ms: number;
}

export type DocType =
  | 'BILL_OF_LADING'
  | 'AIR_WAYBILL'
  | 'PACKING_LIST'
  | 'COMMERCIAL_INVOICE'
  | 'TELEX_RELEASE'
  | 'COURIER_LABEL'
  | 'ARRIVAL_NOTICE'
  | 'DELIVERY_ORDER'
  | 'CERTIFICATE_OF_ORIGIN'
  | 'CUSTOMS_DECLARATION'
  | 'OTHER';

export interface FieldValue {
  value: string | number | null;
  raw?: string; // text the value came from
  page?: number;
  bbox?: [number, number, number, number];
  confidence: number; // 0..1
  method: string; // anchor | regex | validator-repaired | table | derived
  sourceConf?: number; // OCR recognition confidence of the text the value came from (absent = born-digital text)
  valid?: boolean; // validator outcome (undefined = no validator)
  issues?: string[];
}

/** One row (item, package or container). Values are plain keys; `scores` holds a 0..1 confidence per key. */
export interface LineItem {
  [k: string]: any;
  scores: Record<string, number>;
  confidence: number; // lowest score of the row
  page?: number;
  source?: string; // table | block | text | bl | awb
}

export interface Extraction {
  fileName: string;
  docType: DocType;
  docTypeConfidence: number;
  fields: Record<string, FieldValue>;
  lineItems: LineItem[];
  packages?: LineItem[]; // pallets / cartons / boxes with dims and weights
  containers?: LineItem[]; // BL containers
  lineChecks?: { check: string; status: 'pass' | 'fail' | 'n/a'; detail: string }[]; // Σ line values vs printed totals
  needsReview: boolean;
  reviewReasons: string[];
  pages: { page: number; source: PageSource; reason: string; ocrMs?: number }[];
  ms: number;
}
