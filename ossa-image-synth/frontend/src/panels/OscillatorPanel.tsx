import { useEffect, useState } from "react";
import { api, errText } from "../api";
import { useP } from "../ctx";
import { useAction, useLoad } from "../components/bits";

export default function OscillatorPanel() {
  const { project, canEdit, reloadProject, toast, refresh, open } = useP();
  const prov = useLoad<any>(() => api.get(`/api/oscillator/providers`), []);
  const reg = useLoad<any>(() => api.get(`/api/oscillator/registry`), []);
  const ers = useLoad<any[]>(() => api.get(`/api/projects/${project.id}/edit-requests`), [project.id]);
  const jobs = useLoad<any[]>(() => api.get(`/api/projects/${project.id}/jobs`), [project.id]);
  const { run, busy } = useAction();
  const [osc, setOsc] = useState<any>(project.oscillator || { mode: "auto", quality: "high", input_fidelity: true });
  const [erId, setErId] = useState<string>("");
  const [plan, setPlan] = useState<any>(null);
  const approved = (ers.data || []).filter((e) => e.status === "approved");

  useEffect(() => { if (!erId && approved.length) setErId(approved[0].id); }, [ers.data]); // eslint-disable-line
  useEffect(() => { setPlan(null); }, [erId, osc]);

  const active = (jobs.data || []).some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => { jobs.reload(); }, 1200);
    return () => window.clearInterval(t);
  }, [active]); // eslint-disable-line
  const [wasActive, setWasActive] = useState(false);
  useEffect(() => { if (wasActive && !active) { refresh(); reloadProject(); } setWasActive(active); }, [active]); // eslint-disable-line

  const saveOsc = (next: any) => run(async () => { setOsc(await api.put(`/api/projects/${project.id}/oscillator`, next)); await reloadProject(); });
  const doPlan = async () => {
    try { setPlan(await api.post(`/api/projects/${project.id}/oscillator/plan`, { edit_request_id: erId })); } catch (e) { toast(errText(e), "err"); }
  };
  const execute = async () => {
    const s = plan.selection;
    if (!confirm(`Run ${s.provider}/${s.model} (${s.mode.toUpperCase()})?\nEstimated cost: $${(s.estimated_cost_usd || 0).toFixed(2)} (planning estimate)\nBudget remaining: $${plan.budget_remaining_usd.toFixed(2)}`)) return;
    await run(async () => {
      await api.post(`/api/projects/${project.id}/jobs`, { edit_request_id: erId, confirm_estimated_cost_usd: s.estimated_cost_usd || 0 });
      setPlan(null); jobs.reload();
    }, "Job queued");
  };
  const models = (reg.data?.models || []).filter((m: any) => m.provider === (osc.manual_provider || "openai"));

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="card">
        <div className="row"><h3>Providers</h3><div className="spacer" /><button className="small" onClick={async () => { prov.setData(await api.get(`/api/oscillator/providers?refresh=true`)); refresh(); }}>Re-discover models</button></div>
        {(prov.data?.providers || []).map((p: any) => (
          <div key={p.provider} style={{ marginTop: 6 }}>
            <div className="row"><b>{p.label}</b>{p.configured ? <span className="pill ok">credentials configured (server-side)</span> : <span className="pill err">not configured</span>}
              {p.models.length > 0 && <span className="muted">{p.models.length} models discovered</span>}</div>
            {p.error && <div className={p.configured ? "err-box" : "warn-box"} style={{ marginTop: 4 }}>{p.error}{!p.configured && <><br />{p.hint}</>}</div>}
          </div>
        ))}
        <div className="dim" style={{ marginTop: 6 }}>API keys live only on the server. A ChatGPT subscription does not provide API access; an API key from the provider's developer platform is required.</div>
      </div>

      <div className="card col" style={{ gap: 8 }}>
        <h3>Model selection</h3>
        <div className="row">
          <label className="row"><input type="radio" disabled={!canEdit} checked={osc.mode === "auto"} onChange={() => saveOsc({ ...osc, mode: "auto" })} data-testid="mode-auto" /> <b>AUTO BEST</b> <span className="muted">highest-ranked compatible model from the evaluation registry</span></label>
        </div>
        <div className="row">
          <label className="row"><input type="radio" disabled={!canEdit} checked={osc.mode === "manual"} onChange={() => saveOsc({ ...osc, mode: "manual", manual_provider: osc.manual_provider || "openai" })} data-testid="mode-manual" /> <b>MANUAL</b></label>
          {osc.mode === "manual" && (
            <>
              <select value={osc.manual_provider || "openai"} onChange={(e) => saveOsc({ ...osc, manual_provider: e.target.value })}>
                {(prov.data?.providers || []).map((p: any) => <option key={p.provider} value={p.provider}>{p.label}</option>)}
              </select>
              <select value={osc.manual_model || ""} onChange={(e) => saveOsc({ ...osc, manual_model: e.target.value })} data-testid="manual-model">
                <option value="">— choose model —</option>
                {models.map((m: any) => {
                  const disc = (prov.data?.providers || []).find((p: any) => p.provider === m.provider)?.models.includes(m.model);
                  return <option key={m.model} value={m.model}>{m.label} {m.operations.includes("image_edit") ? "" : "· no image editing"}{disc ? "" : " · not available to key"}</option>;
                })}
              </select>
            </>
          )}
        </div>
        <div className="row">
          <label className="row">Quality <select value={osc.quality || "high"} onChange={(e) => saveOsc({ ...osc, quality: e.target.value })}>{["low", "medium", "high"].map((q) => <option key={q}>{q}</option>)}</select></label>
          <label className="row"><input type="checkbox" checked={osc.input_fidelity !== false} onChange={(e) => saveOsc({ ...osc, input_fidelity: e.target.checked })} /> High input fidelity (only sent to models whose registry entry supports it)</label>
        </div>
      </div>

      <div className="card col" style={{ gap: 8 }}>
        <h3>Execute</h3>
        {!approved.length && <div className="warn-box">No approved edit request. <a href="#" onClick={(e) => { e.preventDefault(); open("N04"); }}>Describe and approve one in the Visual Intent Engine.</a></div>}
        <div className="row">
          <select value={erId} onChange={(e) => setErId(e.target.value)} data-testid="osc-er">
            {approved.map((e) => <option key={e.id} value={e.id}>{e.instruction.slice(0, 70)}</option>)}
          </select>
          <button disabled={!erId} onClick={doPlan} data-testid="osc-plan">Check readiness & select model</button>
        </div>
        {plan && (
          <div className="col" style={{ gap: 8 }} data-testid="osc-planresult">
            {plan.gate.blockers.length > 0 && (
              <div className="err-box"><b>Execution blocked by critical modules:</b>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{plan.gate.blockers.map((b: any, i: number) => <li key={i}><a href="#" onClick={(e) => { e.preventDefault(); open(b.module); }}>{b.module} {b.name}</a> — {b.state}: {b.missing.join("; ")}</li>)}</ul>
              </div>
            )}
            {plan.issues.map((s: string, i: number) => <div key={i} className="err-box">{s}</div>)}
            {plan.selection.ok ? (
              <div className="ok-box"><b>{plan.selection.mode.toUpperCase()}: {plan.selection.provider}/{plan.selection.model}</b> · quality {plan.selection.quality} · est. ${plan.selection.estimated_cost_usd?.toFixed(2)}<br />{plan.selection.rationale}</div>
            ) : (
              <div className="err-box"><b>No model selected:</b> {plan.selection.error}
                {plan.selection.note && <div style={{ marginTop: 4 }}>{plan.selection.note}</div>}
                {plan.selection.suggested_alternative && canEdit && (
                  <div style={{ marginTop: 6 }}><button className="small" onClick={() => saveOsc({ ...osc, mode: "manual", manual_provider: plan.selection.suggested_alternative.provider, manual_model: plan.selection.suggested_alternative.model })}>
                    Approve switch to {plan.selection.suggested_alternative.model}</button></div>
                )}
              </div>
            )}
            <table className="t">
              <thead><tr><th>Model</th><th>Available</th><th>Compatible</th><th>Score</th><th>Est. cost</th><th>Reasons / limitations</th></tr></thead>
              <tbody>{plan.selection.candidates.map((c: any) => (
                <tr key={c.provider + c.model} style={c.model === plan.selection.model ? { background: "#1b2a1f" } : undefined}>
                  <td><b>{c.label}</b><div className="dim mono">{c.provider}/{c.model}</div></td>
                  <td>{c.available ? <span className="pill ok">yes</span> : <span className="pill err">no</span>}</td>
                  <td>{c.compatible ? <span className="pill ok">yes</span> : <span className="pill err">no</span>}</td>
                  <td>{c.final_score ?? "—"}{c.adjustment ? <span className="dim"> ({c.adjustment > 0 ? "+" : ""}{c.adjustment})</span> : null}</td>
                  <td>{c.estimated_cost_usd != null ? `$${c.estimated_cost_usd.toFixed(2)}` : "—"}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{c.reasons.join("; ") || c.notes}</td>
                </tr>
              ))}</tbody>
            </table>
            <div className="muted">Compositing: {plan.composite ? "on — original pixels outside the region are restored" : "OFF"} · scope {plan.scope} · budget remaining ${plan.budget_remaining_usd.toFixed(2)}</div>
            {canEdit && <button className="primary" disabled={!plan.ready || busy} onClick={execute} data-testid="osc-run">Run image edit</button>}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Jobs</h3>
        <table className="t"><thead><tr><th>When</th><th>Model</th><th>Status</th><th>Progress</th><th /></tr></thead>
          <tbody>{(jobs.data || []).map((j) => (
            <tr key={j.id}>
              <td className="dim">{new Date(j.created_at).toLocaleString()}</td>
              <td>{j.provider}/{j.model}<div className="dim">{j.selection_mode}</div></td>
              <td><span className={j.status === "succeeded" ? "pill ok" : j.status === "failed" ? "pill err" : "pill warn"}>{j.status}</span></td>
              <td style={{ minWidth: 200 }}><div className="progress"><div style={{ width: `${j.progress}%` }} /></div><div className="dim" style={{ fontSize: 11 }}>{j.message}</div>
                {j.error && <div className="err-box" style={{ fontSize: 11, marginTop: 4 }}>{j.error}</div>}</td>
              <td>{j.status === "succeeded" && <button className="small" onClick={() => open("N08")}>Review</button>}
                {j.status === "queued" && canEdit && <button className="small" onClick={() => run(async () => { await api.post(`/api/projects/${project.id}/jobs/${j.id}/cancel`); jobs.reload(); })}>Cancel</button>}</td>
            </tr>
          ))}{!jobs.data?.length && <tr><td colSpan={5} className="muted">No jobs yet.</td></tr>}</tbody>
        </table>
      </div>
    </div>
  );
}
