# freight-ocr pipeline

The `pipeline/` folder reads freight shipping documents and returns their fields as JSON, with a confidence score for every value. It handles Bills of Lading, Air Waybills / HAWB, packing lists, commercial invoices, telex releases and courier labels.

The folder is self-contained: copy it into your system and use it. It runs on the **CPU only**, with no GPU, no Python, no cloud API and no internet at runtime. The OCR models are included.

This guide covers only the `pipeline/` folder.

---

## What you need

| | |
|---|---|
| Node.js | **24** |
| OS | Linux x64 (glibc) or macOS |
| Memory | about 1.5 GB for the process |
| CPU | 2+ cores (4 recommended for scanned documents) |
| Disk | about 250 MB including `node_modules` |

---

## 1. Get the pipeline folder

```bash
git clone https://github.com/NisharFero/freight-ocr.git
cp -R freight-ocr/pipeline /path/in/your/system/freight-pipeline
cd /path/in/your/system/freight-pipeline
```

Only the `pipeline/` folder is needed. Everything else in the repo can be deleted.

## 2. Install and check it works

```bash
npm install
npm test                 # unit tests: should print "pass 11, fail 0"
```

Read a sample document:

```bash
npx tsx examples/cli.ts eval/synthetic/docs/SYN2/BL_GSLU-JEA-77120_synthetic.pdf
```

```
BL_GSLU-JEA-77120_synthetic.pdf  ->  BILL_OF_LADING (0.99)  pages 1-1  50 ms  REVIEW
  bl_number                  GSLU-JEA-77120                     0.79
  port_of_loading            JEBEL ALI, UAE                     0.94 ✓
  port_of_loading_locode     AEJEA                              0.94 ✓
  ...
```

To read your own document, replace the path. PDF, PNG, JPG, TIFF and WEBP files work.

---

## 3. Connect it to your system

Choose the option that fits your system.

### Option A: HTTP service (any language: Python, Java, .NET, PHP, ...)

Start the service:

```bash
npm run serve            # listens on http://127.0.0.1:8080
```

Upload a document:

```bash
curl -F file=@/path/to/document.pdf http://127.0.0.1:8080/extract
```

**Python:**

```python
import requests
with open("document.pdf", "rb") as f:
    r = requests.post("http://127.0.0.1:8080/extract", files={"file": f})
for doc in r.json()["results"]:
    print(doc["docType"], doc["fields"]["bl_number"]["value"] if "bl_number" in doc["fields"] else "")
```

| Endpoint | Method | Send | Get back |
|---|---|---|---|
| `/extract` | POST | multipart form with a `file` field (max 25 MB) | `{ "results": [ ... ] }`, one entry per document in the file |
| `/health` | GET | | `{ "ok": true }` |

Notes:
- The service is in `examples/http-server.ts`. It listens on localhost only and has **no login**. If other machines must reach it, change `'127.0.0.1'` and the port at the bottom of that file, and put your own auth or a reverse proxy (nginx) in front of it.
- It handles up to 8 uploads at once and returns HTTP 429 when busy.
- To keep it running, use a process manager such as systemd, pm2 or Docker.

### Option B: inside a Node.js / TypeScript app

Build the pipeline once, then add it to your app:

```bash
cd /path/in/your/system/freight-pipeline
npm run build                                          # creates dist/

cd /path/to/your-app
npm install /path/in/your/system/freight-pipeline      # installs it as "freight-extract"
echo "onnxruntime-node-install=skip" >> .npmrc         # avoids a CUDA download on Linux
```

```ts
import { readFile } from 'node:fs/promises';
import { processFile, warmup } from 'freight-extract';

await warmup();                                         // load the OCR models once, at startup

const bytes = new Uint8Array(await readFile('BL.pdf'));
const results = await processFile('BL.pdf', bytes);     // one result per document in the file

for (const r of results) {
  console.log(r.docType);                  // 'BILL_OF_LADING', 'AIR_WAYBILL', 'PACKING_LIST', ...
  console.log(r.fields.bl_number?.value);  // the value
  console.log(r.fields.bl_number?.confidence);
  console.log(r.lineItems);                // table rows
  console.log(r.needsReview, r.reviewReasons);
}
```

- **Express / Fastify / NestJS:** call `processFile(file.originalname, new Uint8Array(file.buffer))` in your upload route.
- **Next.js:** see `examples/nextjs-route.ts`. The route needs `runtime = 'nodejs'`, and the native packages must be listed in `serverExternalPackages`.
- Other functions such as `crossCheck` (compare the documents of one shipment) and `registerApproval` (learn from reviewer approvals) are listed in [`pipeline/README.md`](pipeline/README.md). See `examples/review-and-learn.ts` for how to use them.

### Option C: batch a folder from the command line

Put the files in one sub-folder per shipment:

```
shipments/
├── SHIPMENT-001/   BL.pdf  invoice.pdf  packing-list.pdf
└── SHIPMENT-002/   AWB.pdf  invoice.pdf
```

```bash
npx tsx scripts/run.ts /path/to/shipments
```

This writes one JSON file per document into `out/json/`, and prints the fields plus the cross-checks between the documents of each shipment.

---

## 4. What you get back

```jsonc
{
  "fileName": "BL.pdf",
  "docType": "BILL_OF_LADING",           // or AIR_WAYBILL, PACKING_LIST, COMMERCIAL_INVOICE, TELEX_RELEASE, ...
  "docTypeConfidence": 0.99,
  "pageRange": [1, 2],                   // pages of the file this document came from
  "fields": {
    "bl_number":         { "value": "GSLU-JEA-77120", "confidence": 0.95, "page": 1, "bbox": [x0, y0, x1, y1] },
    "container_numbers": { "value": "MSKU7781235", "confidence": 0.99, "valid": true },
    "gross_weight_kg":   { "value": 19250, "confidence": 0.86, "issues": [] }
  },
  "lineItems":  [ { "part_number": "...", "description": "...", "quantity": 5, "hs_code": "...", "net_kg": 12.5, "confidence": 0.97 } ],
  "packages":   [ { "package_id": "...", "dimensions_cm": "34x20x10", "gross_kg": 1.2, "confidence": 1 } ],
  "containers": [ { "container_number": "MSKU7781235", "container_type": "40HC", "seal_number": "...", "confidence": 1 } ],
  "needsReview": true,
  "reviewReasons": ["new sender/layout: 3 unvalidated field(s) need review (approving teaches this layout)"],
  "pages": [ { "page": 1, "source": "text-layer" } ]   // or "ocr"
}
```

**Fields by document type**

| Document | Main fields |
|---|---|
| All types | `document_number`, `document_date`, `shipper`, `consignee`, `po_numbers`, `incoterm`, `country_of_origin`, `hs_codes`, `gross_weight_kg`, `net_weight_kg`, `total_packages`, `volume_cbm` |
| Bill of Lading / telex | `bl_number`, `vessel`, `voyage`, `port_of_loading`, `port_of_discharge`, `place_of_receipt`, `place_of_delivery`, `container_numbers`, `seal_numbers`, `freight_terms`, `release_type`, `shipped_on_board_date` |
| Air Waybill / HAWB | `mawb_number`, `hawb_number`, `airport_of_departure`, `airport_of_destination`, `flight`, `pieces`, `chargeable_weight_kg` |
| Packing list / invoice | `invoice_number`, `order_number`, `total_amount`, `currency`, plus line items |

## 5. How to use the confidence

- **Accept automatically** only values with `confidence >= 0.8` from documents where `needsReview` is `false`.
- **Send everything else to a person**, showing `reviewReasons` and each field's `issues`.
- Values from a **new sender or layout** stay below 0.8 on purpose. If you call `registerApproval()` when a reviewer approves, that layout can auto-accept after 2 clean approvals.
- For the first weeks, review everything (`SHADOW_MODE=1`) and measure live precision with `computeMetrics()` before you turn on auto-accept.

## 6. Settings (environment variables, all optional)

| Variable | Default | What it does |
|---|---|---|
| `OCR_THREADS` | all cores | CPU threads for OCR; leave 1 core free for your app |
| `OCR_MODEL_DIR` | bundled `models/ppocr-v4` | Use a different OCR model set |
| `OCR_DET_LIMIT` | 1600 | Max image side for text detection (lower = faster, worse on small print) |
| `SPLIT_DOCS` | on | `0` = do not split PDFs that contain several documents |
| `LAYOUT_REGISTRY` | `./data/layouts.json` | Where approved layouts are remembered |
| `LAYOUT_MIN_APPROVALS` | 2 | Approvals before a new layout may auto-accept |
| `FEEDBACK_DIR`, `METRICS_DIR` | `./data/feedback`, `./data/metrics` | Approval and extraction logs |
| `SHADOW_MODE` | off | `1` = report shadow mode on; treat every result as needing review |

**Air-gapped servers:** run `npm install` on a connected machine with the same OS and CPU type, then copy the whole folder, including `node_modules`.

---

## 7. How the OCR pipeline works

```
upload
  │
  ▼
① read PDF text layer ──▶ ② quality check per page ──┬── clean text ─────────────────────────────┐
                                                     └── scanned / garbled ──▶ ③ render page      │
                                                                                ▼                 │
                                                          ④ clean image: grayscale, deskew,        │
                                                             watermark removal, rotation           │
                                                                                ▼                 │
                                                          ⑤ OCR: PP-OCRv4 on ONNX Runtime (CPU)    │
                                                             fallback: Tesseract                   │
                                                                                ▼                 │
                                                          ⑥ re-insert dropped spaces              │
  ┌─────────────────────────────────────────────────────────────────────────────────────────────┘
  ▼
⑦ positioned lines + columns ─▶ ⑧ split merged PDFs ─▶ ⑨ classify doc type ─▶ ⑩ extract fields + line items
  ─▶ ⑪ validate ─▶ ⑫ confidence + review routing ─▶ ⑬ cross-check the documents of one shipment
  ─▶ auto-accept  or  human review ─▶ ⑭ approvals teach the pipeline new layouts
```

| Step | What happens | Code (`pipeline/src/`) |
|---|---|---|
| ① Text layer | Digital PDFs already contain the text. pdf.js reads it with each word's position, so OCR is skipped. This takes about 0.3 s per document. | `ingest.ts` |
| ② Quality check | Each page is tested: enough characters, few garbage characters, enough real dictionary words, and not just one full-page image. A page that fails is sent to OCR. The choice is made **per page**, so a PDF that mixes digital and scanned pages is handled. | `ingest.ts` |
| ③ Render | Pages that need OCR are rendered to images. Exact duplicate pages (such as AWB "Original 1/2/3" copies) are skipped. | `ingest.ts` |
| ④ Image cleanup | The page is converted to grayscale, light watermarks are suppressed, and skew is measured and corrected. Sideways or upside-down pages are detected and read in the right orientation. | `ocr.ts`, `paddle.ts` |
| ⑤ OCR | **PP-OCRv4** (detection + recognition models, in ONNX format) runs on onnxruntime-node. It uses the official PaddleOCR thresholds and returns one box per text block with a recognition confidence. **Tesseract.js** is the fallback engine. | `paddle.ts`, `ocr.ts` |
| ⑥ Space recovery | The recogniser often drops spaces in English text, giving "ACMEFREIGHTLLC". A dictionary plus freight vocabulary splits these runs back into words, and a split is kept only when every part is a known word. | `segment.ts` |
| ⑦ Layout | Text boxes are grouped into reading-order lines, and lines into column segments. Every later step works on these positioned lines, for both text-layer and OCR pages. | `layout.ts` |
| ⑧ Split | One PDF often holds a whole shipment (BL + invoice + packing list). Pages are split into separate documents where the title or document number changes. Continuation pages stay with their document. | `split.ts` |
| ⑨ Classify | A weighted keyword score decides the type. Words in the title zone count more. It also recognises arrival notices, delivery orders, certificates of origin and customs declarations. | `classify.ts` |
| ⑩ Extract | Each field is found from its **label**: the value in the same segment, to the right, or below in the label's column. A synonym dictionary covers wording such as "Port of Loading" / "POL" / "Loading Port". Tables give line items, packages and containers, each value under its header column. | `anchors.ts`, `labels.ts`, `extract.ts`, `lineitems.ts` |
| ⑪ Validate | Check digits and code lists: AWB mod-7, container ISO 6346, HS codes, Incoterms, IATA airports, UN/LOCODE ports, ISO countries and currencies, and EU/US number and date formats. Table sums are compared with printed totals. | `validators.ts`, `gazetteer.ts`, `lineitems.ts` |
| ⑫ Confidence | Each value gets a 0–1 score from how it was found, OCR confidence, validation and plausibility. A score is held below 0.8 when a value is unproven: a new layout, an ambiguous OCR character (O/0, I/1), or a number that could be 7,168 or 7.168. Documents with required fields under 0.8 are marked `needsReview`, with the reasons. | `extract.ts` |
| ⑬ Cross-check | The documents of one shipment are compared: reference numbers, consignee, PO numbers, total gross weight (±3%) and total packages. Values that match across documents are raised to 0.95. | `crossdoc.ts` |
| ⑭ Learn | When a reviewer approves a document, its sender layout is counted. After 2 clean approvals that layout may auto-accept, and any edit resets the count. Every extraction and approval is logged, giving live precision, edit rate and drift alerts. | `layouts.ts`, `monitor.ts` |

**Design choice: rules, not a trained model.** Every value can be traced to the label and position it came from (`method`, `page`, `bbox`), and nothing needs training data to start. The cost is that a new layout may need a label synonym added. Until then its values go to review rather than being guessed.

### Accuracy and speed

| Test set | Auto-accepted values that were correct |
|---|---|
| Client development set (24 documents) | 248 / 248 |
| The same documents rotated, low-dpi, photographed, merged or duplicated (214 variants) | 2,036 / 2,037 |
| 272 public held-out documents from other senders | 392 / 392 |

| | Time |
|---|---|
| Digital PDF | about 0.3 s per document |
| Scanned page | 5–10 s on 2 vCPU (sideways pages about 3× longer) |

OCR runs one page at a time per process. For more throughput, run several processes behind a queue.

---

## What is in the pipeline folder

```
pipeline/
├── src/          the pipeline code (see the step table above)
├── models/       OCR models (PP-OCRv4, 15 MB)
├── examples/     cli.ts, http-server.ts, nextjs-route.ts, review-and-learn.ts
├── scripts/      run.ts (batch a folder) and debug tools
├── tests/        unit tests (npm test)
├── eval/         accuracy tools and sample documents (eval/synthetic/docs)
├── package.json
└── README.md     full API reference
```

## Known limitations

- A new layout may need a label synonym (`src/labels.ts` or `src/extract.ts`) or a known party (`src/gazetteer.ts`). Until then its values go to review.
- The bundled recogniser is PP-OCRv4. A PP-OCRv5 English/Latin model can be dropped into `OCR_MODEL_DIR` with no code change. Arabic is not covered.
- The UN/LOCODE port list is a subset; replace it with the full list for production.
- Tracking numbers on rotated courier labels (FedEx) are not read reliably.
