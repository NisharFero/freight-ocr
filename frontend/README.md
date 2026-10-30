# freight-ocr frontend

A Next.js app on top of [`../pipeline`](../pipeline). It gives reviewers an upload and review screen, and exposes the pipeline as an HTTP API with login, queueing and monitoring. It imports the pipeline source directly: `@/lib/*` points to `../pipeline/src/*` in `tsconfig.json`.

## Run it locally

From the repo root:

```bash
npm install                                                  # installs pipeline + frontend (npm workspaces)
npm run hash-password -w frontend -- reviewer1 '<12+ char password>'
cp frontend/.env.example frontend/.env.local                 # paste the printed line into AUTH_USERS=
npm run dev                                                  # http://localhost:3000
```

For production use, run `npm run build` and then `npm start`.

Every page and API needs a login except `/api/health`. If `AUTH_USERS` is empty, the app returns 503, so it never runs open.

## API

| Route | Method | Body | Returns |
|---|---|---|---|
| `/api/extract` | POST multipart | one or more `file` fields (pdf/png/jpg/tif), optional `engine=paddle\|tesseract` | `{ results: Extraction[] }`, one per document found. A merged PDF returns several, each with `pageRange` and `partOf` |
| `/api/crosscheck` | POST JSON | `{ shipment, docs: Extraction[] }` | `{ checks, docs }`, with confirmed fields boosted |
| `/api/feedback` | POST JSON | `{ fileName, docType, predicted, corrected, edits }` | Appends to `data/feedback/YYYY-MM.jsonl` and updates the layout registry |
| `/api/metrics` | GET `?days=30` | | Live STP, per-field auto-accept precision and edit rate, auto-accept eligibility, drift `alerts[]` |
| `/api/health` | GET | | `{ ok, node, rssMB }` |

```bash
curl -u reviewer1:'<password>' -F file=@../pipeline/eval/synthetic/docs/SYN2/BL_GSLU-JEA-77120_synthetic.pdf localhost:3000/api/extract
```

## Configuration (env, in `frontend/.env.local` or the systemd unit)

| Var | Default | Purpose |
|---|---|---|
| `AUTH_USERS` | – (required) | `user:sha256hex,...` from `npm run hash-password -w frontend` |
| `AUTH_DISABLED` / `AUTH_USER_HEADER` | off / `x-forwarded-user` | Trust an upstream SSO proxy instead of Basic auth |
| `SHADOW_MODE` | off | `1` = never auto-accept; log what would have been accepted |
| `AUTO_ACCEPT_FIELDS` | unset (all) | Pilot allow-list of fields allowed to auto-accept |
| `MAX_QUEUE` | 8 | Uploads in flight before HTTP 429 |
| `OCR_MODEL_DIR` | found automatically | Set it to `../pipeline/models/ppocr-v4` if models are not found |
| `FEEDBACK_DIR`, `METRICS_DIR`, `LAYOUT_REGISTRY` | `./data/...` | Where approvals, the extraction log and learned layouts are stored |

The full list of pipeline settings (`OCR_THREADS`, `SPLIT_DOCS`, `LAYOUT_MIN_APPROVALS`, …) is in [`../pipeline/README.md`](../pipeline/README.md).

## Deploy on RHEL

Run from the repo root on the VM:

```bash
sudo bash frontend/deploy/setup-rhel.sh       # user, /opt + /var/lib dirs, build, systemd, nginx, backup timer
npm run hash-password -w frontend -- reviewer1 '<password>'   # add to /etc/freight-ocr/env AUTH_USERS=
sudo systemctl restart freight-ocr
bash frontend/deploy/smoke.sh https://<host> reviewer1 '<password>' /path/to/sample.pdf
```

- Next listens on `127.0.0.1:3000` only; nginx (`deploy/nginx-freight-ocr.conf`) terminates TLS, sets security headers and rate-limits `/api/extract`.
- Data lives in `/var/lib/freight-ocr`, with a daily backup kept for 30 days. Uploaded files are not stored, only the extracted values.
- The unit starts in `SHADOW_MODE=1`. Run shadow mode for 2 weeks, then enable auto-accept only for fields that `/api/metrics` marks `eligibleForAutoAccept`.
- For an air-gapped VM, run `npm ci` on a connected machine of the same OS and architecture and copy `node_modules` across.
