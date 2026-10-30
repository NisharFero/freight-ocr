'use client';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { Extraction } from '@/lib/types';

type Doc = { id: string; file: File; status: 'queued' | 'running' | 'done' | 'error'; result?: Extraction & { classifierScores?: Record<string, number> }; error?: string; edits: Record<string, string>; approved?: boolean };
type Check = { check: string; status: 'pass' | 'fail' | 'warn' | 'n/a'; detail: string };

const TYPE_LABEL: Record<string, string> = {
  BILL_OF_LADING: 'Bill of Lading', TELEX_RELEASE: 'Telex Release', AIR_WAYBILL: 'Air Waybill', PACKING_LIST: 'Packing List',
  COMMERCIAL_INVOICE: 'Commercial Invoice', COURIER_LABEL: 'Courier Label', ARRIVAL_NOTICE: 'Arrival Notice',
  DELIVERY_ORDER: 'Delivery Order', CERTIFICATE_OF_ORIGIN: 'Certificate of Origin', CUSTOMS_DECLARATION: 'Customs Declaration', OTHER: 'Other',
};
const confColor = (c: number) => (c >= 0.8 ? 'var(--ok)' : c >= 0.6 ? '#d08700' : 'var(--bad)');

export default function Page() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [engine, setEngine] = useState<'paddle' | 'tesseract'>('paddle');
  const [over, setOver] = useState(false);
  const [checks, setChecks] = useState<{ shipment: string; checks: Check[] }[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const update = (id: string, patch: Partial<Doc>) => setDocs((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const addFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => /\.(pdf|png|jpe?g|tiff?|webp)$/i.test(f.name));
    const nd = list.map((file) => ({ id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`, file, status: 'queued' as const, edits: {} }));
    setDocs((ds) => [...ds, ...nd]);
    if (!sel && nd[0]) setSel(nd[0].id);
  }, [sel]);

  async function run() {
    setBusy(true);
    const queue = docs.filter((d) => d.status === 'queued' || d.status === 'error');
    const done: Doc[] = docs.filter((d) => d.status === 'done');
    for (const d of queue) {
      update(d.id, { status: 'running', error: undefined });
      const fd = new FormData();
      fd.append('file', d.file);
      fd.append('engine', engine);
      try {
        const res = await fetch('/api/extract', { method: 'POST', body: fd });
        if (res.status === 401) { update(d.id, { status: 'error', error: 'Login expired or password changed: close this tab, open the page again and log in' }); continue; }
        if (res.status === 429) { update(d.id, { status: 'error', error: 'Server busy: try again in a moment' }); continue; }
        const json = await res.json().catch(() => ({ error: `HTTP ${res.status} ${res.statusText}` }));
        const r = json.results?.[0];
        if (!res.ok || !r || r.error) update(d.id, { status: 'error', error: r?.error ?? json.error ?? res.statusText });
        else {
          update(d.id, { status: 'done', result: r }); done.push({ ...d, status: 'done', result: r });
          // a merged PDF comes back as several documents: show each extra one as its own row
          const extra: Doc[] = (json.results as Extraction[]).slice(1).filter((x: any) => !x.error).map((x, i) => ({ id: `${d.id}-p${i + 2}`, file: d.file, status: 'done', result: x, edits: {} }));
          if (extra.length) { setDocs((ds) => { const at = ds.findIndex((x) => x.id === d.id); return [...ds.slice(0, at + 1), ...extra, ...ds.slice(at + 1)]; }); done.push(...extra); }
        }
      } catch (e) {
        update(d.id, { status: 'error', error: String(e) });
      }
    }
    // group by shipment reference (SRN) when present, else one group for the batch
    const groups = new Map<string, Extraction[]>();
    for (const d of done) {
      const srn = String(d.result?.fields.shipment_ref?.value ?? '').split(',')[0] || 'batch';
      groups.set(srn, [...(groups.get(srn) ?? []), d.result!]);
    }
    if (groups.size > 1 && groups.has('batch')) { // docs without SRN: attach to the only other group if there is exactly one
      const others = [...groups.keys()].filter((k) => k !== 'batch');
      if (others.length === 1) { groups.set(others[0], [...groups.get(others[0])!, ...groups.get('batch')!]); groups.delete('batch'); }
    }
    const out = [];
    for (const [shipment, list] of groups) {
      if (list.length < 2) continue;
      const res = await fetch('/api/crosscheck', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shipment, docs: list }) });
      const cc = await res.json();
      out.push({ shipment: cc.shipment, checks: cc.checks });
      // fields confirmed across documents come back with raised confidence
      setDocs((ds) => ds.map((d) => { const u = (cc.docs as Extraction[]).find((x) => x.fileName === d.result?.fileName && x.ms === d.result?.ms); return u ? { ...d, result: { ...d.result!, ...u } } : d; }));
    }
    setChecks(out);
    setBusy(false);
  }

  async function approve(d: Doc) {
    if (!d.result) return;
    const fields = Object.fromEntries(Object.entries(d.result.fields).map(([k, v]) => [k, d.edits[k] ?? v.value]));
    await fetch('/api/feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: d.file.name, pageRange: (d.result as any).pageRange, docType: d.result.docType, needsReview: d.result.needsReview, wouldAutoAccept: (d.result as any).wouldAutoAccept ?? !d.result.needsReview, shadow: !!(d.result as any).shadow, ms: d.result.ms, predicted: d.result.fields, corrected: fields, edits: d.edits, lineItems: d.result.lineItems }),
    });
    update(d.id, { approved: true });
  }

  function download() {
    const payload = docs.filter((d) => d.result).map((d) => ({
      fileName: d.file.name, docType: d.result!.docType, approved: !!d.approved,
      fields: Object.fromEntries(Object.entries(d.result!.fields).map(([k, v]) => [k, d.edits[k] ?? v.value])),
      lineItems: d.result!.lineItems, needsReview: d.result!.needsReview, reviewReasons: d.result!.reviewReasons,
    }));
    const blob = new Blob([JSON.stringify({ documents: payload, crossChecks: checks }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `extraction-${new Date().toISOString().slice(0, 19)}.json`;
    a.click();
  }

  const current = docs.find((d) => d.id === sel);
  const stats = useMemo(() => {
    const done = docs.filter((d) => d.result);
    return { done: done.length, review: done.filter((d) => d.result!.needsReview && !d.approved).length, total: docs.length };
  }, [docs]);

  return (
    <>
      <header className="top">
        <h1>Freight Document Extractor</h1>
        <span>BL · AWB · Packing List · Invoice · Telex release — CPU OCR, runs on-prem</span>
      </header>
      <main>
        <div
          className={`drop ${over ? 'over' : ''}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}
        >
          <strong>Drop shipment documents here</strong>
          <small>PDF (digital or scanned), PNG, JPG · several files from one shipment are reconciled against each other</small>
          <input ref={input} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp" hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
        </div>

        <div className="toolbar">
          <button className="primary" disabled={busy || !docs.some((d) => d.status === 'queued' || d.status === 'error')} onClick={run}>
            {busy ? <><span className="spin" /> Extracting…</> : 'Extract'}
          </button>
          <label className="sub">OCR engine&nbsp;
            <select value={engine} onChange={(e) => setEngine(e.target.value as 'paddle' | 'tesseract')}>
              <option value="paddle">PaddleOCR (ONNX)</option>
              <option value="tesseract">Tesseract.js</option>
            </select>
          </label>
          <button disabled={!stats.done} onClick={download}>Download JSON</button>
          <button disabled={busy || !docs.length} onClick={() => { setDocs([]); setChecks([]); setSel(null); }}>Clear</button>
          <span className="stats">{stats.done}/{stats.total} processed · {stats.review} need review</span>
        </div>

        {!docs.length ? <div className="panel empty">No documents yet.</div> : (
          <div className="grid">
            <div className="list">
              {docs.map((d) => (
                <div key={d.id} className={`item ${d.id === sel ? 'sel' : ''}`} onClick={() => setSel(d.id)}>
                  <div className="name">{d.file.name}</div>
                  <div className="meta">
                    {d.status === 'running' && <span className="badge"><span className="spin" /> running</span>}
                    {d.status === 'queued' && <span className="badge">queued</span>}
                    {d.status === 'error' && <span className="badge bad">error</span>}
                    {d.result && <span className="badge">{TYPE_LABEL[d.result.docType]}</span>}
                    {d.result && (d.approved ? <span className="badge ok">approved</span> : (d.result as any).shadow ? <span className="badge warn" title="shadow mode: nothing is pushed automatically">{(d.result as any).wouldAutoAccept ? 'shadow: would auto-accept' : 'review'}</span> : d.result.needsReview ? <span className="badge warn">review</span> : <span className="badge ok">auto-accept</span>)}{(d.result as any)?.partOf && <span className="badge">part {(d.result as any).partOf.part}/{(d.result as any).partOf.parts}</span>}
                  </div>
                </div>
              ))}
            </div>

            <div>
              {checks.map((c) => (
                <div className="panel checks" key={c.shipment}>
                  <h2>Shipment {c.shipment} — cross-document checks</h2>
                  <table><tbody>
                    {c.checks.map((k, i) => (
                      <tr key={i}>
                        <td className="s"><span className={`badge ${k.status === 'pass' ? 'ok' : k.status === 'fail' ? 'bad' : k.status === 'warn' ? 'warn' : ''}`}>{k.status}</span></td>
                        <td>{k.check}</td><td className="sub">{k.detail}</td>
                      </tr>
                    ))}
                  </tbody></table>
                </div>
              ))}
              {current && <DocView d={current} onEdit={(k, v) => update(current.id, { edits: { ...current.edits, [k]: v }, approved: false })} onApprove={() => approve(current)} />}
            </div>
          </div>
        )}
      </main>
    </>
  );
}

function DocView({ d, onEdit, onApprove }: { d: Doc; onEdit: (k: string, v: string) => void; onApprove: () => void }) {
  if (d.status === 'error') return <div className="panel"><h2>{d.file.name}</h2><p className="sub" style={{ color: 'var(--bad)' }}>{d.error}</p></div>;
  if (!d.result) return <div className="panel"><h2>{d.file.name}</h2><p className="sub">{d.status === 'running' ? 'Processing… scanned pages take a few seconds each on CPU.' : 'Waiting — press Extract.'}</p></div>;
  const r = d.result;
  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h2>{d.file.name}</h2>
        <span className="badge">{TYPE_LABEL[r.docType]} · {Math.round(r.docTypeConfidence * 100)}%</span>
        <span className="sub">{(r.ms / 1000).toFixed(1)} s</span>
        <span style={{ marginLeft: 'auto' }}><button className="primary" onClick={onApprove} disabled={d.approved}>{d.approved ? 'Approved ✓' : 'Approve'}</button></span>
      </div>
      <div className="pages">{r.pages.map((p) => `p${p.page}: ${p.source}${p.ocrMs ? ` ${(p.ocrMs / 1000).toFixed(1)}s` : ''} (${p.reason})`).join(' · ')}</div>
      {r.needsReview && !d.approved && <ul className="reasons">{r.reviewReasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}

      <h3>Fields</h3>
      <table>
        <thead><tr><th>Field</th><th>Value</th><th>Confidence</th><th>Check</th><th>Source</th></tr></thead>
        <tbody>
          {Object.entries(r.fields).map(([k, v]) => {
            const val = d.edits[k] ?? String(v.value ?? '');
            return (
              <tr key={k}>
                <td className="k">{k}</td>
                <td><input className={d.edits[k] !== undefined ? 'edited' : ''} value={val} onChange={(e) => onEdit(k, e.target.value)} title={v.raw ?? ''} /></td>
                <td><span className="conf"><span className="bar"><i style={{ width: `${v.confidence * 100}%`, background: confColor(v.confidence) }} /></span>{v.confidence.toFixed(2)}</span></td>
                <td>{v.valid === true ? <span className="badge ok">valid</span> : v.valid === false ? <span className="badge bad" title={v.issues?.join('; ')}>failed</span> : ''}</td>
                <td className="sub">{v.method}{v.page ? ` · p${v.page}` : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {(r.lineChecks?.length ?? 0) > 0 && (
        <>
          <h3>Line checks</h3>
          <ul className="checks">{r.lineChecks!.map((c, i) => <li key={i}><span className={`badge ${c.status === 'pass' ? 'ok' : c.status === 'fail' ? 'bad' : ''}`}>{c.status}</span> {c.check} <span className="sub">{c.detail}</span></li>)}</ul>
        </>
      )}
      <RowTable title="Line items" rows={r.lineItems} />
      <RowTable title="Packages (pallets / cartons / boxes)" rows={r.packages ?? []} />
      <RowTable title="Containers" rows={r.containers ?? []} />
    </div>
  );
}

// Columns in reading order; package_ref / po_ref are values carried from the package row above (shown in grey).
const ROW_ORDER = ['line_no', 'package_id', 'package_ref', 'marks', 'part_number', 'customer_part_number', 'nimr_part_number', 'description', 'quantity', 'unit', 'count', 'package_type', 'hs_code', 'country_of_origin', 'po_number', 'po_ref', 'po_line', 'net_kg', 'gross_kg', 'gross_lb', 'dimensions_cm', 'dimensions_in', 'volume_cbm', 'unit_price', 'amount', 'container_number', 'container_type', 'seal_number', 'packages', 'forklift'];
const ROW_META = new Set(['scores', 'confidence', 'page', 'source', 'issues']);

/** A table of rows where every value shows its score: green >= 0.9, amber >= 0.7, red below (hover for the number). */
function RowTable({ title, rows }: { title: string; rows: Extraction['lineItems'] }) {
  if (!rows.length) return null;
  const keys = [...new Set(rows.flatMap((x) => Object.keys(x)).filter((k) => !ROW_META.has(k)))];
  const cols = [...ROW_ORDER.filter((k) => keys.includes(k)), ...keys.filter((k) => !ROW_ORDER.includes(k))];
  const low = rows.filter((x) => x.confidence < 0.9).length;
  return (
    <>
      <h3>{title} ({rows.length}){low ? <span className="badge warn" style={{ marginLeft: 8 }}>{low} to check</span> : <span className="badge ok" style={{ marginLeft: 8 }}>all ≥ 0.90</span>}</h3>
      <div style={{ overflowX: 'auto' }}>
        <table className="rows">
          <thead><tr><th>#</th>{cols.map((c) => <th key={c}>{c.replace(/_/g, ' ')}</th>)}<th>score</th></tr></thead>
          <tbody>{rows.map((li, i) => (
            <tr key={i} title={li.issues?.join('\n') ?? ''}>
              <td className="sub">{i + 1}</td>
              {cols.map((c) => {
                const v = li[c]; const sc = li.scores?.[c];
                const carried = c.endsWith('_ref');
                return <td key={c} className={v == null ? '' : carried ? 'carried' : sc == null ? '' : sc >= 0.9 ? 'hi' : sc >= 0.7 ? 'mid' : 'lo'} title={sc != null ? `score ${sc.toFixed(2)}` : carried ? 'from the package row above' : ''}>{v == null ? '' : String(v)}</td>;
              })}
              <td><span className="conf"><span className="bar"><i style={{ width: `${li.confidence * 100}%`, background: confColor(li.confidence) }} /></span>{li.confidence.toFixed(2)}</span></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </>
  );
}
