import { useEffect, useRef, useState } from "react";
import { api, errText, fileUrl } from "../api";
import { useP } from "../ctx";
import { SaveButton, useAction, useLoad } from "../components/bits";
import { store } from "../store";

export default function OscillatorPanel() {
  const { project, canEdit, toast, open } = useP();
  const ers = useLoad<any[]>(() => api.get(`/api/projects/${project.id}/edit-requests`), [project.id]);
  const { run, busy } = useAction();
  const [erId, setErId] = useState("");
  const [plan, setPlan] = useState<any>(null);
  const [over, setOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const approved = (ers.data || []).filter((e) => e.status === "approved");
  const runs = useLoad<any[]>(async () => store.s.runs.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)), [project.id]);
  const active = (runs.data || []).find((r) => r.status === "awaiting_result");

  useEffect(() => { if (!erId && approved.length) setErId(approved[0].id); }, [ers.data]); // eslint-disable-line
  useEffect(() => { setPlan(null); }, [erId]);

  const check = async () => {
    try { setPlan(await api.post(`/api/projects/${project.id}/runs/plan`, { edit_request_id: erId })); } catch (e) { toast(errText(e), "err"); }
  };
  const start = () => run(async () => { await api.post(`/api/projects/${project.id}/runs`, { edit_request_id: erId }); setPlan(null); runs.reload(); }, "Run started — follow the three steps below");
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast("Instructions copied", "ok"); }
    catch { promptRef.current?.select(); toast("Press Ctrl+C to copy the selected instructions", "info"); }
  };
  const importFile = async (f: File | undefined) => {
    if (!f || !active) return;
    const fd = new FormData();
    fd.append("file", f);
    setImporting(true);
    try {
      await api.post(`/api/projects/${project.id}/runs/${active.id}/result`, fd);
      toast("Edited image checked. Review it in Output & Validation.", "ok");
      runs.reload();
      open("N08");
    } catch (e) { toast(errText(e), "err"); } finally { setImporting(false); }
  };
  const activeEr = active && (ers.data || []).find((e) => e.id === active.request_id);

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="card col" style={{ gap: 6 }}>
        <h3>AI engines</h3>
        <div className="row"><span className="pill ok">available</span><b>ChatGPT image editing</b><span className="muted">uses your own ChatGPT account, in a separate tab</span></div>
        <div className="row"><span className="pill">needs server edition</span><b>OpenAI API, fully automatic</b><span className="muted">needs a server to keep the API key secret</span></div>
        <div className="dim">Whatever the AI returns, Image Synth puts back the original pixels outside your edit area and measures the result before you can approve it.</div>
      </div>

      {!active && (
        <div className="card col" style={{ gap: 8 }}>
          <h3>Start an edit</h3>
          {!approved.length && <div className="warn-box">No approved edit request yet. <a href="#" onClick={(e) => { e.preventDefault(); open("N04"); }}>Describe and approve one in the Visual Intent Engine.</a></div>}
          {approved.length > 0 && (
            <div className="row">
              <select id="osc-er" value={erId} onChange={(e) => setErId(e.target.value)} data-testid="osc-er">
                {approved.map((e) => <option key={e.id} value={e.id}>{e.instruction.slice(0, 70)}</option>)}
              </select>
              <button onClick={check} data-testid="osc-plan">Check readiness</button>
            </div>
          )}
          {plan && (
            <>
              {plan.gate.blockers.length > 0 && (
                <div className="err-box"><b>Cannot run:</b> {plan.gate.blockers.map((b: any) => b.missing.join(" ")).join(" ")}</div>
              )}
              {plan.gate.blockers.length === 0 && plan.gate.warnings.length > 0 && (
                <div className="warn-box"><b>Insufficient information: the result may be less refined.</b> It will run at your responsibility.
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{plan.gate.warnings.map((b: any, i: number) => (
                    <li key={i}><a href="#" onClick={(e) => { e.preventDefault(); open(b.module); }}>{b.name}</a>: {b.missing.join("; ")}</li>))}</ul>
                </div>
              )}
              {plan.gate.blockers.length === 0 && plan.gate.warnings.length === 0 && <div className="ok-box">Ready. All information is in place.</div>}
              {canEdit && <div><button className="primary" disabled={!plan.ready || busy} onClick={start} data-testid="osc-run">Start run</button></div>}
            </>
          )}
        </div>
      )}

      {active && activeEr && (
        <div className="card col" style={{ gap: 12, borderColor: "var(--brand)" }} data-testid="osc-active">
          <div className="row"><h3>Run in progress</h3><span className="muted">“{activeEr.instruction.slice(0, 80)}”</span><div className="spacer" />
            <button className="small ghost" onClick={() => run(async () => { await api.post(`/api/projects/${project.id}/runs/${active.id}/cancel`); runs.reload(); }, "Run cancelled")}>Cancel run</button></div>
          <div className="step"><span className="stepn">1</span><div className="col" style={{ gap: 4 }}>
            <b>Save the image for the AI</b>
            <span className="muted">A copy of your render, framed to a size ChatGPT keeps. Your original is never changed.</span>
            <div><SaveButton src={fileUrl(`/api/projects/${project.id}/images/${active.image_id}/prepared`)} filename="image-synth-for-chatgpt.png" label="Save image" className="primary small" /></div>
          </div></div>
          <div className="step"><span className="stepn">2</span><div className="col" style={{ gap: 4, flex: 1, minWidth: 0 }}>
            <b>Copy the instructions</b>
            <textarea ref={promptRef} id="osc-prompt" className="mono" rows={6} readOnly value={active.prompt} />
            <div><button className="small" onClick={() => copy(active.prompt)}>Copy instructions</button></div>
          </div></div>
          <div className="step"><span className="stepn">3</span><div className="col" style={{ gap: 4 }}>
            <b>Edit it in ChatGPT</b>
            <span className="muted">Open ChatGPT, attach the saved image, paste the instructions, then download the image ChatGPT returns.</span>
            <div><a className="btnlink" href="https://chatgpt.com/" target="_blank" rel="noreferrer">Open ChatGPT ↗</a></div>
          </div></div>
          <div className="step"><span className="stepn">4</span><div className="col" style={{ gap: 4, flex: 1 }}>
            <b>Drop the edited image here</b>
            <div className={"drop" + (over ? " over" : "")} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); importFile(e.dataTransfer.files[0]); }} onClick={() => fileRef.current?.click()}>
              {importing ? "Lining up and checking the image…" : "Drop the image from ChatGPT, or click to choose it"}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden data-testid="result-input" onChange={(e) => importFile(e.target.files?.[0])} />
            </div>
          </div></div>
        </div>
      )}

      <div className="card">
        <h3>Runs</h3>
        <table className="t"><thead><tr><th>Started</th><th>Engine</th><th>Status</th><th /></tr></thead>
          <tbody>{(runs.data || []).map((r) => (
            <tr key={r.id}><td className="dim">{new Date(r.created_at).toLocaleString()}</td><td>ChatGPT (manual)</td>
              <td><span className={r.status === "returned" ? "pill ok" : r.status === "awaiting_result" ? "pill warn" : "pill"}>{r.status.replace("_", " ")}</span></td>
              <td>{r.status === "returned" && <button className="small" onClick={() => open("N08")}>Review</button>}</td></tr>
          ))}{!runs.data?.length && <tr><td colSpan={4} className="muted">No runs yet.</td></tr>}</tbody></table>
      </div>
    </div>
  );
}
