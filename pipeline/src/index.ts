// freight-extract: public API. Everything a product needs to add freight-document extraction:
// OCR + extraction + validation (processFile), shipment reconciliation (crossCheck), learning from approvals
// (registerApproval), live monitoring (logExtraction / computeMetrics), and the building blocks for custom rules.
import { getEngine } from './paddle';
import { loadDict } from './segment';

export { processFile, processDocument, type Result } from './pipeline';
export type { IngestOptions } from './ingest';
export { crossCheck, type Check } from './crossdoc';
export { classify } from './classify';
export { splitPages } from './split';
export { extractFields, ACCEPT_THRESHOLD, REQUIRED } from './extract';
export { registerApproval, isFamiliar, fingerprint, MIN_APPROVALS } from './layouts';
export { logExtraction, computeMetrics, shadowMode } from './monitor';
export { validAwb, formatAwb, validContainer, fixContainer, normIncoterm, normHs, parseNumber, parseDate, detectLocale } from './validators';
export { matchParty, resolvePort, resolveAirport, resolveCountry, KNOWN_PARTIES } from './gazetteer';
export type { DocType, FieldValue, Extraction, LineItem, PageData, Line, Segment } from './types';

/** Load the OCR models and dictionary once at startup so the first upload is not slow (about 1-2 s). */
export async function warmup(): Promise<void> {
  await Promise.all([getEngine(), loadDict()]);
}
