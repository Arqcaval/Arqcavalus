import { useRef, useState } from "react";
import { api, errText, fileUrl } from "../api";
import { useP } from "../ctx";
import { StatusPill, useAction, useLoad } from "../components/bits";

const MOD_NAMES: Record<string, string> = {
  N01: "Project Understanding", N02: "Finish Schedule", N03: "Equipment", N04: "Visual Intent", N05: "Source Images",
};

export default function IntakePanel() {
  const { project, canEdit, toast, refresh } = useP();
  const docs = useLoad<any[]>(() => api.get(`/api/projects/${project.id}/documents`), [project.id]);
  const types = useLoad<any[]>(() => api.get(`/api/projects/meta/doc-types`), []);
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [view, setView] = useState<any | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const { run } = useAction();

  const upload = async (files: FileList | File[]) => {
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append("files", f));
    setUploading(true);
    try {
      const res = await api.post<any[]>(`/api/projects/${project.id}/documents`, fd);
      const errs = res.filter((r) => r.error);
      errs.forEach((e) => toast(`${e.name}: ${e.error}`, "err"));
      const ok = res.length - errs.length;
      if (ok) toast(`${ok} file(s) uploaded and processed. Review the proposed mappings below.`, "ok");
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setUploading(false);
      docs.reload();
      refresh();
    }
  };

  const openDoc = async (id: string) => setView(await api.get(`/api/projects/${project.id}/documents/${id}`));

  return (
    <div className="col" style={{ gap: 12 }}>
      {canEdit && (
        <div
          className={"drop" + (over ? " over" : "")} data-testid="dropzone"
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}
          onClick={() => input.current?.click()}
        >
          <div style={{ fontSize: 15, color: "var(--text)" }}>{uploading ? "Uploading and extracting…" : "Drop project documents here, or click to choose"}</div>
          <div style={{ marginTop: 4 }}>PDF · PNG · JPEG · WEBP · CSV · XLSX · TXT/MD specifications — max size set by server</div>
          <div className="dim" style={{ marginTop: 2 }}>DWG / RVT are stored and identified but <b>not parsed</b> (no CAD reader configured). Export sheets to PDF and schedules to CSV/XLSX.</div>
          <input ref={input} type="file" multiple hidden data-testid="file-input" onChange={(e) => e.target.files && upload(e.target.files)} />
        </div>
      )}
      <div className="info-box">Uploading a file does not satisfy a module. Each proposed mapping and every extracted record must be reviewed.</div>
      <div style={{ overflowX: "auto" }}>
      <table className="t">
        <thead><tr><th>Document</th><th>Classification</th><th>Proposed module mapping</th><th>Status</th></tr></thead>
        <tbody>
          {(docs.data || []).map((d) => (
            <tr key={d.id}>
              <td>
                <a href="#" onClick={(e) => { e.preventDefault(); openDoc(d.id); }}>{d.original_name}</a>
                <div className="dim mono">{(d.size / 1024).toFixed(0)} KB · {d.ext.toUpperCase()} · {d.page_count || 0} p · {d.record_count} records</div>
                {d.meta?.duplicate_of && <div className="pill warn">duplicate content of an earlier upload</div>}
              </td>
              <td style={{ minWidth: 190 }}>
                {canEdit ? (
                  <select value={d.doc_type} data-testid={`classify-${d.original_name}`} onChange={(e) => run(async () => {
                    const reason = prompt("Reason for reclassification (recorded in the QA log)") ?? "";
                    await api.patch(`/api/projects/${project.id}/documents/${d.id}`, { doc_type: e.target.value, reason });
                    docs.reload();
                  }, "Classification overridden; document re-processed")}>
                    {(types.data || []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                ) : d.doc_type_label}
                <div className="dim" style={{ fontSize: 11 }}>
                  {d.classification_source === "manual" ? "manual override" : `auto · confidence ${(d.classification_confidence * 100).toFixed(0)}%`}
                </div>
                <details><summary className="dim" style={{ fontSize: 11, cursor: "pointer" }}>evidence</summary>
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11 }} className="muted">{(d.classification_evidence || []).map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>
                </details>
              </td>
              <td>
                {d.mappings.length === 0 && <span className="dim">{d.status === "unsupported" ? "—" : "No module uses this type"}</span>}
                {d.mappings.map((m: any) => (
                  <div key={m.id} className="row" style={{ marginBottom: 3, flexWrap: "nowrap", whiteSpace: "nowrap" }}>
                    <span className="mono">{m.module_key}</span> {MOD_NAMES[m.module_key]} <StatusPill status={m.status} />
                    {canEdit && m.status !== "accepted" && <button className="small ok" onClick={() => run(async () => { await api.patch(`/api/projects/${project.id}/mappings/${m.id}`, { status: "accepted" }); docs.reload(); })}>Accept</button>}
                    {canEdit && m.status !== "rejected" && <button className="small" onClick={() => run(async () => { await api.patch(`/api/projects/${project.id}/mappings/${m.id}`, { status: "rejected" }); docs.reload(); })}>Reject</button>}
                  </div>
                ))}
              </td>
              <td>
                <StatusPill status={d.status} />
                {d.error && <div className={d.status === "unsupported" ? "warn-box" : "err-box"} style={{ fontSize: 11, marginTop: 4 }}>{d.error}</div>}
                {(d.meta?.warnings || []).map((w: string, i: number) => <div key={i} className="warn-box" style={{ fontSize: 11, marginTop: 4 }}>{w}</div>)}
                {canEdit && d.status === "error" && <button className="small" onClick={() => run(async () => { await api.post(`/api/projects/${project.id}/documents/${d.id}/reprocess`); docs.reload(); })}>Retry</button>}
              </td>
            </tr>
          ))}
          {docs.data?.length === 0 && <tr><td colSpan={4} className="muted">No documents uploaded.</td></tr>}
        </tbody>
      </table>
      </div>
      {view && (
        <div className="card">
          <div className="row"><h3>{view.original_name}</h3><div className="spacer" />
            <a href={fileUrl(`/api/projects/${project.id}/documents/${view.id}/file`)} target="_blank" rel="noreferrer">Open original</a>
            <button className="small" onClick={() => setView(null)}>Close</button></div>
          <div className="kv" style={{ margin: "8px 0" }}>
            <span>SHA-256</span><span className="mono">{view.sha256}</span>
            <span>Type</span><span>{view.doc_type_label}</span>
          </div>
          {["png", "jpg", "webp"].includes(view.ext) && <img src={fileUrl(`/api/projects/${project.id}/documents/${view.id}/file`, { thumb: true })} style={{ maxWidth: "100%" }} />}
          <h4>Extracted records ({view.records.length})</h4>
          <table className="t"><tbody>{view.records.map((r: any) => (
            <tr key={r.id}><td className="mono">{r.module_key}</td><td>{r.record_type}</td><td><b>{r.key}</b></td><td className="dim">{r.source_ref}</td><td><StatusPill status={r.status} /></td></tr>
          ))}</tbody></table>
          {view.text_excerpt && <><h4>Extracted text</h4><pre className="mono" style={{ whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto", background: "var(--bg)", padding: 8, borderRadius: 6 }}>{view.text_excerpt}</pre></>}
        </div>
      )}
    </div>
  );
}
