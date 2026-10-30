# freight-extract

`freight-extract` is a library that reads freight shipment documents and returns typed fields with a confidence for each field. It runs on the CPU only, on Node 24, with no GPU, no Python, no cloud calls and no internet at runtime.

It handles these document types: Bill of Lading, Air Waybill / HAWB, packing list, commercial invoice, telex release and courier label. It also classifies arrival notices, delivery orders, certificates of origin and customs declarations.

This is the `pipeline/` folder of the `freight-ocr` repo. The `frontend/` folder adds the review UI, login and deployment on top of it.

```ts
import { processFile, warmup } from 'freight-extract';

await warmup();                                    // load OCR models once at startup
const results = await processFile('BL.pdf', bytes); // bytes: Uint8Array of a PDF / PNG / JPG / TIFF / WEBP
for (const r of results) {                          // one result per document (a merged shipment PDF gives several)
  r.docType;            // 'BILL_OF_LADING' | 'AIR_WAYBILL' | 'PACKING_LIST' | 'COMMERCIAL_INVOICE' | ...
  r.fields.bl_number;   // { value, confidence, valid, issues, method, page, bbox, raw }
  r.needsReview;        // true unless every required field is >= 0.8 and the layout is proven
  r.reviewReasons;      // why, in plain words
}
```

## Install

```bash
npm install /path/to/freight-ocr/pipeline     # from a clone of this repo, or publish it to your private registry
```

- **Node 24** on linux-x64 (glibc) or macOS.
- The repo's `.npmrc` sets `onnxruntime-node-install=skip`, so npm does not try to download CUDA; the CPU binaries ship inside the package. Copy that line into your app's `.npmrc`.
- The OCR models are in `models/ppocr-v4` (15 MB) and are found automatically. To use a different model set, set `OCR_MODEL_DIR`.
- **Next.js:** add the package and its native dependencies to `serverExternalPackages`, and use `runtime = 'nodejs'` (see `examples/nextjs-route.ts`).
- **Air-gapped servers:** run `npm ci` on a connected machine of the same OS and architecture, then copy `node_modules` across.

## API

| Export | What it does |
|---|---|
| `processFile(name, bytes, opts?)` → `Result[]` | Full pipeline for one file. It routes each page to the text layer or OCR, splits multi-document PDFs, then classifies, extracts, validates and scores. `opts.engine`: `'paddle'` (default) or `'tesseract'`; `opts.forceOcr` |
| `processDocument(name, bytes)` → `Result` | Same, but treats the file as one document (no splitting) |
| `warmup()` | Loads the ONNX models and dictionary. Call it at boot |
| `crossCheck(shipmentId, results)` | Reconciles the documents of one shipment: shipment ref, consignee, POs, Σ gross weight (±3%), Σ packages. Returns `{checks, docs}` with confirmed fields raised to 0.95 |
| `registerApproval(docType, correctedFields, hadEdits)` | Call when a reviewer approves a document. Two clean approvals per sender layout let that layout auto-accept; an edit resets the count |
| `logExtraction(result)` / `computeMetrics(days)` | Extraction log and live metrics: STP, per-field auto-accept precision and edit rate, eligibility for auto-accept, drift alerts |
| `shadowMode()` | `true` when `SHADOW_MODE=1`. Treat every result as needing review and log `wouldAutoAccept` |
| `ACCEPT_THRESHOLD` (0.8), `REQUIRED[docType]` | Auto-accept threshold and the required fields per type |
| Validators | `validAwb`, `validContainer`, `fixContainer`, `normIncoterm`, `normHs`, `parseNumber`, `parseDate`, `detectLocale` |
| Gazetteer | `matchParty`, `resolvePort`, `resolveAirport`, `resolveCountry`, `KNOWN_PARTIES` (edit `src/gazetteer.ts` for your master data) |
| Building blocks | `classify`, `splitPages`, `extractFields`, `isFamiliar`, `fingerprint` |
| Types | `Result`, `Extraction`, `FieldValue`, `DocType`, `LineItem`, `PageData`, … |

## Result shape

```jsonc
{
  "fileName": "BL.pdf", "docType": "BILL_OF_LADING", "docTypeConfidence": 0.99,
  "pageRange": [1, 2],                         // pages of the file this document came from
  "partOf": { "file": "...", "part": 1, "parts": 3 },   // only when a PDF was split
  "fields": {
    "bl_number":   { "value": "JNB/NAV/01189", "confidence": 0.95, "method": "same-segment", "page": 1, "bbox": [x0,y0,x1,y1] },
    "container_numbers": { "value": "MSDU1350467", "confidence": 0.99, "valid": true },
    "gross_weight_kg": { "value": 270, "confidence": 0.86, "issues": [] }
  },
  "lineItems": [ { "part_number": "...", "description": "...", "quantity": 5, "hs_code": "...", "net_kg": 12.5, "package_ref": "PACK0000600",
                   "scores": { "part_number": 1, "description": 1, "quantity": 0.97, "hs_code": 1, "net_kg": 0.97 }, "confidence": 0.97 } ],
  "packages": [ { "package_id": "PACK0000600", "package_type": "BOX", "dimensions_cm": "34x20x10", "gross_kg": 1.2, "scores": { "...": 1 }, "confidence": 1 } ],
  "containers": [ { "container_number": "MSKU7781235", "container_type": "40HC", "seal_number": "ML-4410921", "packages": 20, "gross_kg": 19250, "volume_cbm": 26.4, "scores": { "...": 1 }, "confidence": 1 } ],
  "lineChecks": [ { "check": "line items: Σ quantity = printed total", "status": "pass", "detail": "Σ 2585 vs total 2585" } ],
  "needsReview": false, "reviewReasons": [],
  "pages": [ { "page": 1, "source": "text-layer", "reason": "text-layer ok" } ],
  "ms": 310
}
```

- **Fields, all types:** `document_number`, `document_date`, `shipper(_address)`, `consignee(_address)`, `po_numbers`, `shipment_ref`, `incoterm`, `country_of_origin`, `hs_codes`, `gross_weight_kg`, `net_weight_kg`, `total_packages`, `volume_cbm`.
- **BL / telex:** `bl_number`, `notify_party`, `vessel`, `voyage`, `port_of_loading/_discharge`, `place_of_receipt/_delivery` (+ `_locode`), `container_numbers`, `seal_numbers`, `freight_terms`, `release_type`, `shipped_on_board_date`, `carrier_or_issuer`.
- **AWB:** `mawb_number`, `hawb_number`, `issuing_agent`, `airport_of_departure/_destination`, `flight`, `pieces`, `chargeable_weight_kg`, `currency`.
- **Packing list / invoice:** `invoice_number`, `order_number`, `total_amount`, `currency`, plus line items.

## How to use the confidence

- **Push** only values with `confidence >= 0.8` from documents with `needsReview === false`.
- **Show everything else** to a person, with `reviewReasons` and `issues`.
- **Start in shadow mode** (`SHADOW_MODE=1`): review everything for 2 weeks and let `computeMetrics()` measure live precision per field. Then enable auto-accept per field once a field has ≥ 200 observations at ≥ 99% precision.
- **Wire approvals back:** `examples/review-and-learn.ts` shows the two calls to make when a reviewer approves.

Confidence below 0.8 is deliberate when a value is unproven:
- the sender or layout is new
- an OCR character is ambiguous (O/0, I/1)
- OCR recognition confidence is low
- a number has an ambiguous format (`7,168` could be 7168 or 7.168)
- a container list may be incomplete

Validated values (check digit, gazetteer, cross-document match) get higher confidence.

## Configuration (environment)

| Var | Default | Purpose |
|---|---|---|
| `OCR_MODEL_DIR` | bundled `models/ppocr-v4` | det.onnx + rec.onnx + dict.txt |
| `OCR_THREADS` | all cores | ONNX Runtime threads (leave 1 core for the app) |
| `OCR_DET_LIMIT` | 1600 | max side for text detection |
| `SPLIT_DOCS` | on | `0` disables multi-document splitting |
| `LAYOUT_REGISTRY` | `./data/layouts.json` | clean-approval counts per sender layout |
| `LAYOUT_MIN_APPROVALS` | 2 | clean approvals before a new layout may auto-accept |
| `FEEDBACK_DIR`, `METRICS_DIR` | `./data/feedback`, `./data/metrics` | approval and extraction logs for `computeMetrics` |
| `SHADOW_MODE` | off | `1` = report `shadowMode() === true` |
| `ACCEPT_THRESHOLD` | 0.8 | threshold used by `computeMetrics` |

## Performance and limits

| Item | Value |
|---|---|
| Digital PDF | 0.1–0.7 s per document |
| Scanned page | 5–10 s on 2 vCPU; sideways pages about 3× |
| Memory | about 1.4 GB in a server process |
| Concurrency | OCR is serialised per process. Queue uploads, or cap them, as the app does with `MAX_QUEUE` |
| Max pages | 20 per file |

**Accuracy** (freight-ocr release gate, 24 Oct 2026):
- **The 24 client documents:** 248 of 248 auto-accepted values correct.
- **The same documents rotated, low-dpi, photographed, merged or duplicated:** 2,036 of 2,037.
- **272 public held-out documents:** 392 of 392.
- **A new layout:** about 65% blind field F1, with its values sent to review until it is approved twice.

## Layout

```
src/index.ts       public API
src/pipeline.ts    processFile: ingest -> space recovery -> split -> classify -> extract
src/ingest.ts      PDF text layer + QA gate, rendering, duplicate pages, orientation
src/ocr.ts         preprocessing, rotation retries, Tesseract fallback
src/paddle.ts      PP-OCRv4 on onnxruntime-node (detection, deskew, recognition)
src/segment.ts     re-insert spaces OCR dropped
src/layout.ts      boxes -> lines -> column segments
src/split.ts       multi-document PDF splitter
src/classify.ts    document-type classifier
src/anchors.ts     label-anchored value lookups
src/labels.ts      caption synonyms, Label: value pass, plausibility
src/extract.ts     per-type extractors, confidence calibration, review reasons
src/lineitems.ts   table / part-number line items
src/validators.ts  AWB mod-7, ISO 6346, HS, Incoterms, numbers, dates
src/gazetteer.ts   parties, airports, ports, countries, currencies
src/crossdoc.ts    shipment reconciliation
src/layouts.ts     layout familiarity registry
src/monitor.ts     extraction log, live metrics, drift alerts
models/ppocr-v4/   OCR models
examples/          cli.ts, http-server.ts, nextjs-route.ts, review-and-learn.ts
tests/             unit tests (npm test)
eval/              scorers, perturbation suite, release gate, synthetic and public held-out sets
scripts/           batch runner (run.ts) and debug tools (lines.ts, boxes.ts, one.ts, textdbg.ts)
```

## Develop

```bash
npm ci && npm test && npm run build      # dist/index.js + .d.ts
npx tsx examples/cli.ts some.pdf
```

Run the release gate (`npm run eval:all`) before publishing a new version. The client ground-truth files (`eval/gold.json`, `eval/gold_lineitems.json`) are not in the public repo; add them locally to run the scorers on the client set.
