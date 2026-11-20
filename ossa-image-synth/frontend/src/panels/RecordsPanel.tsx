import { useState } from "react";
import { api } from "../api";
import { useP } from "../ctx";
import type { Rec } from "../types";
import { OriginPill, StatusPill, useAction, useLoad } from "../components/bits";

const COLUMNS: Record<string, { type: string; fields: [string, string][] }[]> = {
  N01: [
    { type: "project_info", fields: [["field", "Field"], ["value", "Value"]] },
    { type: "room", fields: [["number", "No."], ["name", "Room / space"]] },
    { type: "drawing_ref", fields: [["sheet", "Sheet"], ["title", "Title"]] },
    { type: "constraint", fields: [["text", "Constraint / scope note"]] },
  ],
  N02: [{ type: "finish", fields: [["category", "Material"], ["manufacturer", "Manufacturer"], ["product", "Product"], ["color_name", "Color"], ["texture", "Texture / sheen"], ["dimensions", "Size"], ["application", "Application / location"], ["drawing_refs", "Drawing"]] }],
  N03: [
    { type: "equipment", fields: [["description", "Description"], ["manufacturer", "Mfr"], ["model", "Model"], ["dimensions", "Dimensions"], ["schedule_location", "Schedule location"], ["location_verified", "Location verified"]] },
    { type: "equipment_location", fields: [["plan_ref", "Found on plan at"]] },
  ],
};
const TYPE_LABEL: Record<string, string> = {
  project_info: "Project identity", room: "Rooms & spaces", drawing_ref: "Drawing references", constraint: "Constraints & scope",
  finish: "Finish records", equipment: "Equipment schedule", equipment_location: "Plan cross-check evidence (verify each)",
};
const CATEGORIES = ["paint", "laminate", "solid_surface", "tile", "wood_paneling", "acoustic_ceiling", "stone", "quartz", "metal", "glass", "carpet", "resilient_flooring", "resilient_base", "other"];

export default function RecordsPanel({ module }: { module: "N01" | "N02" | "N03" }) {
  const { project, canEdit } = useP();
  const recs = useLoad<Rec[]>(() => api.get(`/api/projects/${project.id}/records?module=${module}`), [project.id, module]);
  const { run, busy } = useAction();
  const [edit, setEdit] = useState<Rec | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [showRejected, setShowRejected] = useState(false);

  const setStatus = (r: Rec, status: string) => run(async () => { await api.patch(`/api/projects/${project.id}/records/${r.id}`, { status }); recs.reload(); });
  const approveAll = (type: string) => run(async () => {
    for (const r of (recs.data || []).filter((x) => x.record_type === type && x.status === "proposed")) {
      await api.patch(`/api/projects/${project.id}/records/${r.id}`, { status: "approved" });
    }
    recs.reload();
  }, "All proposals approved");

  const sections = COLUMNS[module];
  return (
    <div className="col" style={{ gap: 14 }}>
      {module === "N02" && <div className="info-box">Finishes come only from documents or explicit user entries. Never from lighting, shadows or AI image analysis. Records marked <span className="pill warn">reference</span> are OSSA starting points and must be confirmed against this project's schedule.</div>}
      {module === "N03" && <div className="info-box">An equipment schedule never validates locations on its own. Accept an equipment plan, then verify each item's location (approve the plan evidence or mark the item verified).</div>}
      <label className="row muted"><input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} /> show rejected</label>
      {sections.map((sec) => {
        const rows = (recs.data || []).filter((r) => r.record_type === sec.type && (showRejected || r.status !== "rejected"));
        const pending = rows.filter((r) => r.status === "proposed").length;
        return (
          <div key={sec.type} className="card">
            <div className="row" style={{ marginBottom: 6 }}>
              <h3>{TYPE_LABEL[sec.type]}</h3><span className="muted">{rows.length}</span>
              {pending > 0 && <span className="pill warn">{pending} to review</span>}
              <div className="spacer" />
              {canEdit && pending > 0 && <button className="small" disabled={busy} onClick={() => approveAll(sec.type)}>Approve all shown after review</button>}
              {canEdit && sec.type !== "equipment_location" && <button className="small" onClick={() => { setAdding(sec.type); setDraft({}); }}>+ Add manually</button>}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="t">
                <thead><tr><th>Key</th>{sec.fields.map(([f, l]) => <th key={f}>{l}</th>)}<th>Source & evidence</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={`st-${r.status}`} data-testid={`rec-${r.key}`}>
                      <td><b>{r.key}</b><div><OriginPill origin={r.origin} /></div></td>
                      {sec.fields.map(([f]) => <td key={f}>{typeof r.data[f] === "boolean" ? (r.data[f] ? <span className="pill ok">verified</span> : <span className="pill err">not verified</span>) : String(r.data[f] ?? "")}</td>)}
                      <td style={{ maxWidth: 260 }}>
                        <div className="mono" style={{ fontSize: 11 }}>{r.document_name ? `${r.document_name} · ` : ""}{r.source_ref}</div>
                        <div className="dim" style={{ fontSize: 11 }} title={r.evidence}>“{r.evidence.slice(0, 120)}{r.evidence.length > 120 ? "…" : ""}”</div>
                        {r.notes && <div style={{ fontSize: 11, color: "var(--warn)" }}>{r.notes}</div>}
                        <div className="dim" style={{ fontSize: 10 }}>confidence {(r.confidence * 100).toFixed(0)}%</div>
                      </td>
                      <td><StatusPill status={r.status} /></td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {canEdit && r.status !== "approved" && <button className="small ok" onClick={() => setStatus(r, "approved")}>Approve</button>}{" "}
                        {canEdit && r.status !== "rejected" && <button className="small" onClick={() => setStatus(r, "rejected")}>Reject</button>}{" "}
                        {canEdit && <button className="small ghost" onClick={() => setEdit(r)}>Correct</button>}
                        {canEdit && r.record_type === "equipment" && !r.data.location_verified && r.status === "approved" && (
                          <button className="small" onClick={() => run(async () => { await api.patch(`/api/projects/${project.id}/records/${r.id}`, { data: { location_verified: true } }); recs.reload(); }, "Location marked verified (recorded)")}>Mark location verified</button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={sec.fields.length + 4} className="muted">None.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      {(edit || adding) && (
        <div className="card" style={{ borderColor: "var(--brand)" }}>
          <h3>{edit ? `Correct ${edit.key}` : `Add ${TYPE_LABEL[adding!]}`}</h3>
          <div className="muted" style={{ margin: "4px 0 8px" }}>{edit ? "Corrections are recorded in the QA log with before/after values." : "Manual entries are stored as user-entered approved facts."}</div>
          <div className="kv" style={{ gridTemplateColumns: "150px 1fr", gap: 6 }}>
            <span>Key / code</span>
            <input value={edit ? (draft.__key ?? edit.key) : (draft.__key ?? "")} onChange={(e) => setDraft({ ...draft, __key: e.target.value })} />
            {sections.find((s) => s.type === (edit?.record_type || adding))!.fields.filter(([f]) => f !== "location_verified").map(([f, l]) => (
              <FieldInput key={f} f={f} l={l} value={draft[f] ?? (edit ? edit.data[f] ?? "" : "")} onChange={(v) => setDraft({ ...draft, [f]: v })} />
            ))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={() => run(async () => {
              const { __key, ...data } = draft;
              if (edit) await api.patch(`/api/projects/${project.id}/records/${edit.id}`, { data, ...(__key ? { key: __key } : {}) });
              else await api.post(`/api/projects/${project.id}/records`, { module_key: module, record_type: adding, key: __key || "", data: module === "N03" ? { ...data, location_verified: false } : data });
              setEdit(null); setAdding(null); setDraft({}); recs.reload();
            }, "Saved")}>Save</button>
            <button onClick={() => { setEdit(null); setAdding(null); setDraft({}); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function FieldInput({ f, l, value, onChange }: { f: string; l: string; value: any; onChange: (v: any) => void }) {
  return (
    <>
      <span>{l}</span>
      {f === "category" ? (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>{CATEGORIES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
        </select>
      ) : <input value={value} onChange={(e) => onChange(e.target.value)} />}
    </>
  );
}
