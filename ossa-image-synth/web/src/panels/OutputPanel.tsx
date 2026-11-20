import { useEffect, useState } from "react";
import { api, fileUrl } from "../api";
import { useP } from "../ctx";
import { SaveButton, StatusPill, useAction, useLoad } from "../components/bits";
import CompareViewer from "./CompareViewer";

const CATS = ["user_correction", "material_error", "geometry_change", "equipment_hallucination", "unauthorized_edit", "failed_generation"];

export default function OutputPanel() {
  const { project, canReview, open } = useP();
  const gens = useLoad<any[]>(() => api.get(`/api/projects/${project.id}/generations`), [project.id]);
  const { run, busy } = useAction();
  const [gid, setGid] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState("");
  const [cat, setCat] = useState("material_error");
  const [revised, setRevised] = useState("");
  const [lesson, setLesson] = useState(false);
  useEffect(() => { if (gens.data?.length && !gens.data.find((g) => g.id === gid)) setGid(gens.data[0].id); }, [gens.data]); // eslint-disable-line
  const g = (gens.data || []).find((x) => x.id === gid);
  useEffect(() => { setReason(""); setOverride(""); setRevised(g?.instruction || ""); }, [gid]); // eslint-disable-line

  if (gens.data && !gens.data.length) return <div className="muted">No outputs yet. Run an edit from the <a href="#" onClick={(e) => { e.preventDefault(); open("N07"); }}>AI Engine</a>.</div>;
  if (!g) return <div className="muted">Loading…</div>;
  const u = (variant: string) => fileUrl(`/api/projects/${project.id}/generations/${g.id}/file`, { variant });
  const pending = g.status === "pending_review";
  const decide = (decision: string) => run(async () => {
    const r = await api.post(`/api/projects/${project.id}/generations/${g.id}/decision`, {
      decision, reason, override_reason: override, qa_category: cat, revised_instruction: revised, make_lesson: lesson,
    });
    gens.reload();
    if (r.new_edit_request_id) open("N04");
  }, decision === "approve" ? "Output approved and recorded" : decision === "reject" ? "Output rejected and logged" : "Revision requested — new draft edit request created");

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row">
        <span className="muted">Version</span>
        <select value={gid || ""} onChange={(e) => setGid(e.target.value)} data-testid="gen-select">
          {(gens.data || []).map((x) => <option key={x.id} value={x.id}>v{x.version} · {x.model} · {x.status} · {new Date(x.created_at).toLocaleString()}</option>)}
        </select>
        <StatusPill status={g.status === "pending_review" ? "pending review" : g.status} />
        <div className="spacer" />
        <SaveButton src={u("final")} filename={`output_v${g.version}.png`} label="Download PNG" />
      </div>
      <div className="muted">“{g.instruction}” · {g.scope === "local" ? "edit area only" : "whole image"} · edited in ChatGPT · {g.composited ? "original pixels restored outside the area" : "not composited"}</div>
      {g.insufficient_info && <div className="warn-box"><b>Made with insufficient information.</b> This result may be less refined. Missing: {(g.run_warnings || []).join(" · ")}</div>}
      <CompareViewer original={u("source")} output={u("final")} diff={u("diff")} mask={u("mask")} raw={u("raw")} />

      <div className="card" data-testid="checks">
        <h3>Automated checks</h3>
        {g.validation.checks.map((c: any) => (
          <div key={c.id} className="check">
            <span style={{ color: c.passed ? "var(--ok)" : c.blocking ? "var(--err)" : "var(--warn)", width: 16 }}>{c.passed ? "✓" : "✕"}</span>
            <div><div>{c.label} {!c.blocking && <span className="dim">(advisory)</span>}</div><div className="dim" style={{ fontSize: 11 }}>{c.detail}</div></div>
          </div>
        ))}
      </div>

      <div className="card col" style={{ gap: 6 }}>
        <div className="row"><h3>Claude's second opinion</h3><span className="pill ai">advisory</span><div className="spacer" />
          {canReview && <button className="small" disabled={busy} onClick={() => run(() => api.post(`/api/projects/${project.id}/generations/${g.id}/ai-review`), "Claude reviewed the output")}>{g.ai_review ? "Ask again" : "Ask Claude to compare"}</button>}</div>
        {g.ai_review ? <div style={{ whiteSpace: "pre-wrap" }}>{g.ai_review}</div> : <div className="dim">Claude compares the original and the output and lists any changes beyond the request. It does not replace your checklist.</div>}
      </div>

      <div className="card">
        <h3>Material / finish compliance checklist</h3>
        <div className="dim" style={{ marginBottom: 6 }}>Visual items a reviewer must confirm. Automated checks cannot judge material accuracy.</div>
        {g.checklist.items.map((i: any) => (
          <label key={i.id} className="check">
            <input type="checkbox" disabled={!pending || !canReview} checked={!!i.checked} data-testid={`chk-${i.id}`}
              onChange={(e) => run(async () => { await api.patch(`/api/projects/${project.id}/generations/${g.id}/checklist`, { items: { [i.id]: e.target.checked } }); gens.reload(); })} />
            <span>{i.label}{i.checked_by && <span className="dim"> — {i.checked_by}</span>}</span>
          </label>
        ))}
      </div>

      {pending && canReview && (
        <div className="card col" style={{ gap: 8 }}>
          <h3>Decision</h3>
          {g.approval_blocked && <div className="err-box">Approval is blocked: {!g.validation.automated_passed ? "required automated checks failed" : ""}{!g.validation.automated_passed && !g.checklist_complete ? " and " : ""}{!g.checklist_complete ? "the reviewer checklist is incomplete" : ""}. A project owner or reviewer may override with a recorded reason.</div>}
          <textarea rows={2} placeholder="Reason / notes (required for reject and revise)" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="decision-reason" />
          {g.approval_blocked && <textarea rows={2} placeholder="Override reason (only if approving despite failed checks)" value={override} onChange={(e) => setOverride(e.target.value)} />}
          <div className="row">
            <label className="row">QA category <select value={cat} onChange={(e) => setCat(e.target.value)}>{CATS.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}</select></label>
            <label className="row"><input type="checkbox" checked={lesson} onChange={(e) => setLesson(e.target.checked)} /> Save as project lesson</label>
          </div>
          <label className="col" style={{ gap: 3 }}>Revised instruction (for another iteration)
            <textarea rows={2} value={revised} onChange={(e) => setRevised(e.target.value)} /></label>
          <div className="row">
            <button className="ok" disabled={busy || (g.approval_blocked && !override.trim())} onClick={() => decide("approve")} data-testid="approve">{g.approval_blocked ? "Approve with override" : "Approve"}</button>
            <button className="danger" disabled={busy || !reason.trim()} onClick={() => decide("reject")} data-testid="reject">Reject</button>
            <button disabled={busy || !reason.trim()} onClick={() => decide("revise")}>Request revision</button>
          </div>
        </div>
      )}
      {!pending && (
        <div className={g.status === "approved" ? "ok-box" : "warn-box"}>
          {g.status.replace("_", " ")} on {new Date(g.decided_at).toLocaleString()} {g.decision_reason && `— “${g.decision_reason}”`}
          {g.override_reason && <div>Override reason: {g.override_reason}</div>}
        </div>
      )}
    </div>
  );
}
