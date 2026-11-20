import { useEffect, useState } from "react";
import { api } from "../api";
import { useP } from "../ctx";
import { store } from "../store";
import { useAction, useLoad } from "./bits";

export default function Admin(_: { onProjectsChanged: () => void }) {
  const { project, canEdit } = useP();
  const qa = useLoad<any>(() => api.get(`/api/projects/${project.id}/qa`), [project.id]);
  const { run, busy } = useAction();
  const [p, setP] = useState({ name: project.name, code: project.code || "", description: project.description || "" });
  const [rule, setRule] = useState("");
  useEffect(() => setP({ name: project.name, code: project.code || "", description: project.description || "" }), [project.id]); // eslint-disable-line
  return (
    <div className="page-scroll col">
      <div className="card col" style={{ gap: 8 }}>
        <h3>Share with Jack and the team</h3>
        <p style={{ margin: 0 }}>Use the <b>Share</b> button at the top of this page and add each person by email.</p>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li><b>Editor</b>: can upload documents and renders, draw masks, run edits and approve results. Give Jack this.</li>
          <li><b>Contributor</b>: can review records and decide on outputs, but cannot upload files.</li>
          <li><b>Viewer</b>: can look, not change.</li>
        </ul>
        <p className="dim" style={{ margin: 0 }}>Everyone works on the same projects; changes appear for everyone right away.</p>
      </div>
      <div className="card col" style={{ gap: 8 }}>
        <h3>Project details</h3>
        <div className="kv" style={{ gridTemplateColumns: "120px 1fr", gap: 6 }}>
          <label htmlFor="set-name">Name</label><input id="set-name" disabled={!canEdit} value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
          <label htmlFor="set-code">Code</label><input id="set-code" disabled={!canEdit} value={p.code} onChange={(e) => setP({ ...p, code: e.target.value })} />
          <label htmlFor="set-desc">Description</label><textarea id="set-desc" disabled={!canEdit} value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} />
        </div>
        {canEdit && <div><button className="primary" disabled={busy || !p.name.trim()} onClick={() => run(() => api.patch(`/api/projects/${project.id}`, p), "Saved")}>Save</button></div>}
      </div>
      <div className="card col" style={{ gap: 8 }}>
        <h3>Studio-wide rules</h3>
        <div className="dim">These apply to every project and are added to the instructions for every AI edit. Project-specific lessons live in the Learning & QA Log.</div>
        {(qa.data?.global || []).map((e: any) => (
          <div key={e.id} className="row"><span style={e.active === false ? { opacity: .5 } : undefined}>{e.title}</span><div className="spacer" />
            {canEdit && <button className="small ghost" onClick={() => run(() => api.patch(`/api/qa/global/${e.id}`, { active: e.active === false }))}>{e.active === false ? "Turn on" : "Turn off"}</button>}</div>
        ))}
        {!qa.data?.global?.length && <div className="muted">No studio-wide rules yet.</div>}
        {canEdit && <form className="row" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post(`/api/qa/global`, { title: rule }); setRule(""); }, "Rule added"); }}>
          <input id="new-rule" style={{ flex: 1, minWidth: 0 }} placeholder="New rule, e.g. Keep existing slim black separators" value={rule} onChange={(e) => setRule(e.target.value)} />
          <button disabled={!rule.trim()} type="submit">Add rule</button></form>}
      </div>
      <div className="card col" style={{ gap: 6 }}>
        <h3>About this edition</h3>
        <ul style={{ margin: 0, paddingLeft: 18 }} className="muted">
          <li>Projects, files and decisions are stored with this page on claude.ai.</li>
          <li>AI image edits run in your own ChatGPT tab; Image Synth prepares the image and instructions and checks the result.</li>
          <li>Claude can read scanned documents and review outputs; its readings are marked as AI assumptions until you approve them.</li>
          <li>DWG and Revit files are recognised but not read. Export sheets to PDF and schedules to CSV/XLSX.</li>
          {!store.canUpload && <li><b>You cannot upload files with your current access.</b> Ask the owner for Editor access.</li>}
        </ul>
      </div>
    </div>
  );
}
