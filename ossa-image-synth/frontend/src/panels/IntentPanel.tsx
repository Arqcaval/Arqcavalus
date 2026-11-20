import { useEffect, useState } from "react";
import { api, fileUrl } from "../api";
import { useP } from "../ctx";
import type { SourceImage } from "../types";
import { StatusPill, useAction, useLoad } from "../components/bits";

export default function IntentPanel() {
  const { project, canEdit, open } = useP();
  const imgs = useLoad<SourceImage[]>(() => api.get(`/api/projects/${project.id}/images`), [project.id]);
  const ers = useLoad<any[]>(() => api.get(`/api/projects/${project.id}/edit-requests`), [project.id]);
  const { run, busy } = useAction();
  const [selId, setSelId] = useState<string | null>(null);
  const [f, setF] = useState<any>({ instruction: "", scope: "local", composite: true, global_authorized: false, allow_object_additions: false });
  const authorized = (imgs.data || []).filter((i) => i.status === "authorized");
  const sel = (ers.data || []).find((e) => e.id === selId) || null;

  useEffect(() => {
    if (!selId && ers.data?.length) setSelId(ers.data[0].id);
  }, [ers.data]); // eslint-disable-line
  useEffect(() => {
    if (sel) setF({ source_image_id: sel.source_image_id, instruction: sel.instruction, scope: sel.scope, edit_mask_id: sel.edit_mask_id,
      protected_mask_id: sel.protected_mask_id, composite: sel.composite, global_authorized: sel.global_authorized, allow_object_additions: sel.allow_object_additions });
  }, [selId]); // eslint-disable-line

  const img = (imgs.data || []).find((i) => i.id === f.source_image_id);
  const editMasks = img?.masks.filter((m) => m.kind === "edit") || [];
  const protMasks = img?.masks.filter((m) => m.kind === "protected") || [];
  const a = sel?.analysis;

  const submitNew = () => run(async () => {
    const r = await api.post(`/api/projects/${project.id}/edit-requests`, f);
    await ers.reload(); setSelId(r.id);
  }, "Edit request analysed");
  const saveChanges = () => run(async () => { await api.patch(`/api/projects/${project.id}/edit-requests/${sel.id}`, f); ers.reload(); }, "Updated and re-analysed — approval reset");
  const approve = () => run(async () => { await api.patch(`/api/projects/${project.id}/edit-requests/${sel.id}`, { status: "approved" }); ers.reload(); }, "Edit request approved");

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row">
        <span className="muted">Edit request</span>
        <select value={selId || ""} onChange={(e) => setSelId(e.target.value || null)} data-testid="er-select">
          <option value="">+ New request</option>
          {(ers.data || []).map((e) => <option key={e.id} value={e.id}>{e.status === "approved" ? "✓ " : ""}{e.instruction.slice(0, 60)}</option>)}
        </select>
        {sel && <StatusPill status={sel.status} />}
      </div>
      <div className="card col" style={{ gap: 8 }}>
        <label className="col" style={{ gap: 3 }}>Source image
          <select value={f.source_image_id || ""} onChange={(e) => setF({ ...f, source_image_id: e.target.value, edit_mask_id: null, protected_mask_id: null })} data-testid="er-image">
            <option value="">— select an authorised source image —</option>
            {authorized.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
          </select>
          {!authorized.length && <span className="warn-box">No authorised source images. <a href="#" onClick={(e) => { e.preventDefault(); open("N05"); }}>Authorise one in Source Image Integrity.</a></span>}
        </label>
        <label className="col" style={{ gap: 3 }}>Required modification
          <textarea rows={3} data-testid="er-instruction" placeholder="e.g. Change the lower cabinet faces to PL2. Keep the SS2 backsplash and black separators unchanged." value={f.instruction} onChange={(e) => setF({ ...f, instruction: e.target.value })} />
        </label>
        <div className="row">
          <label className="row"><input type="radio" checked={f.scope === "local"} onChange={() => setF({ ...f, scope: "local" })} /> Local (masked) edit — default</label>
          <label className="row"><input type="radio" checked={f.scope === "global"} onChange={() => setF({ ...f, scope: "global" })} /> Global edit</label>
        </div>
        {f.scope === "local" && (
          <label className="row">Edit mask
            <select value={f.edit_mask_id || ""} onChange={(e) => setF({ ...f, edit_mask_id: e.target.value || null })} data-testid="er-mask">
              <option value="">— none —</option>
              {editMasks.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.coverage.toFixed(1)}%){m.status !== "approved" ? " — draft, not approved" : ""}</option>)}
            </select>
            {img && !editMasks.length && <a href="#" onClick={(e) => { e.preventDefault(); open("N05"); }}>Draw an edit mask</a>}
          </label>
        )}
        <label className="row">Protected mask
          <select value={f.protected_mask_id || ""} onChange={(e) => setF({ ...f, protected_mask_id: e.target.value || null })}>
            <option value="">— none —</option>
            {protMasks.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.coverage.toFixed(1)}%){m.status !== "approved" ? " — draft" : ""}</option>)}
          </select>
        </label>
        {f.scope === "global" && <label className="row warn-box"><input type="checkbox" checked={f.global_authorized} onChange={(e) => setF({ ...f, global_authorized: e.target.checked })} /> I authorise a global edit of the entire image (protected regions still apply).</label>}
        <label className="row"><input type="checkbox" checked={f.composite} onChange={(e) => setF({ ...f, composite: e.target.checked })} /> Retain original pixels outside the edit region by compositing (recommended)</label>
        {!f.composite && <div className="warn-box">Without compositing, the provider's output is used as-is and pixels outside the mask are not guaranteed to be preserved. Validation will block approval if they change.</div>}
        <label className="row"><input type="checkbox" checked={f.allow_object_additions} onChange={(e) => setF({ ...f, allow_object_additions: e.target.checked })} /> Allow object additions (requires explicit approval)</label>
        {canEdit && (
          <div className="row">
            {!sel && <button className="primary" disabled={busy || !f.source_image_id || !f.instruction.trim()} onClick={submitNew} data-testid="er-analyse">Analyse intent</button>}
            {sel && <button disabled={busy} onClick={saveChanges}>Save changes & re-analyse</button>}
            {sel && <button className="ok" disabled={busy || a?.blocking || sel.status === "approved"} onClick={approve} data-testid="er-approve">Approve edit request</button>}
            {sel?.status === "approved" && <button className="primary" onClick={() => open("N07")}>Continue to Oscillator →</button>}
          </div>
        )}
      </div>
      {a && (
        <div className="card col" style={{ gap: 6 }} data-testid="er-analysis">
          <h3>Intent analysis</h3>
          <div className="row">{a.categories.map((c: string) => <span key={c} className="pill">{c.replace(/_/g, " ")}</span>)}</div>
          {a.issues.map((i: any, n: number) => <div key={n} className={i.severity === "block" ? "err-box" : "warn-box"}><b>{i.severity === "block" ? "Blocking" : "Warning"}:</b> {i.message}</div>)}
          {!a.blocking && <div className="ok-box">No blocking issues.</div>}
          <h4>Referenced finishes</h4>
          {a.referenced_finishes.length === 0 && <div className="muted">None referenced.</div>}
          {a.referenced_finishes.map((r: any) => (
            <div key={r.code} className="row"><b>{r.code}</b><StatusPill status={r.status} />
              {r.data && <span>{r.data.manufacturer} {r.data.product} <span className="dim">({r.data.category})</span></span>}
              {r.source && <span className="dim mono">source: {r.source}</span>}
            </div>
          ))}
          <div className="muted">Requires modules: {a.requires_modules.join(", ")}</div>
          <h4>Lessons applied ({a.lessons_applied.length})</h4>
          <ul style={{ margin: 0, paddingLeft: 18 }} className="muted">{a.lessons_applied.map((l: any) => <li key={l.id}>{l.title} <span className="dim">[{l.scope}]</span></li>)}</ul>
          <details><summary style={{ cursor: "pointer" }}>Provider prompt preview</summary><pre className="mono" style={{ whiteSpace: "pre-wrap", background: "var(--bg)", padding: 8, borderRadius: 6 }}>{a.prompt}</pre></details>
          {sel?.source_image_id && (
            <>
              <h4>Edit region preview</h4>
              <img style={{ width: "100%", borderRadius: 6 }} src={fileUrl(`/api/projects/${project.id}/images/${sel.source_image_id}/mask-preview`, { edit_mask_id: sel.edit_mask_id || undefined, protected_mask_id: sel.protected_mask_id || undefined, v: sel.id })} />
              <div className="dim">green = editable · red = protected</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
