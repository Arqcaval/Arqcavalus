import { useState } from "react";
import { api } from "../api";
import { useP } from "../ctx";
import { useAction, useLoad } from "../components/bits";

export default function QAPanel() {
  const { project, canReview, user } = useP();
  const qa = useLoad<any>(() => api.get(`/api/projects/${project.id}/qa`), [project.id]);
  const { run } = useAction();
  const [filter, setFilter] = useState("");
  const [f, setF] = useState({ category: "user_correction", title: "", detail: "", is_lesson: false });
  const rows = (qa.data?.project || []).filter((e: any) => !filter || e.category === filter || (filter === "lessons" && e.is_lesson));
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="info-box">This is a reviewable record, not automatic learning. Active lessons are added to every provider prompt for this project; global rules apply to all projects. Model rankings are adjusted only by recorded approvals, rejections and failures.</div>
      {canReview && (
        <div className="card col" style={{ gap: 6 }}>
          <h3>Add entry</h3>
          <div className="row">
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{(qa.data?.categories || []).map((c: string) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}</select>
            <input style={{ flex: 1 }} placeholder="Title, e.g. Bar die wall is PL2, not paint" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
            <label className="row"><input type="checkbox" checked={f.is_lesson} onChange={(e) => setF({ ...f, is_lesson: e.target.checked })} /> project lesson</label>
            <button className="primary" disabled={!f.title.trim()} onClick={() => run(async () => { await api.post(`/api/projects/${project.id}/qa`, f); setF({ ...f, title: "", detail: "" }); qa.reload(); }, "Logged")}>Add</button>
          </div>
          <textarea rows={2} placeholder="Detail" value={f.detail} onChange={(e) => setF({ ...f, detail: e.target.value })} />
        </div>
      )}
      <div className="row">
        <span className="muted">Filter</span>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">all</option><option value="lessons">lessons only</option>
          {(qa.data?.categories || []).map((c: string) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
        </select>
      </div>
      <table className="t">
        <thead><tr><th>When</th><th>Category</th><th>Entry</th><th>Lesson</th></tr></thead>
        <tbody>{rows.map((e: any) => (
          <tr key={e.id} style={!e.active ? { opacity: .5 } : undefined}>
            <td className="dim" style={{ whiteSpace: "nowrap" }}>{new Date(e.created_at).toLocaleString()}</td>
            <td><span className="pill">{e.category.replace(/_/g, " ")}</span></td>
            <td><b>{e.title}</b>{e.detail && <div className="dim" style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>{e.detail}</div>}</td>
            <td style={{ whiteSpace: "nowrap" }}>
              {e.is_lesson ? <span className="pill ok">{e.active ? "active lesson" : "inactive"}</span> : null}
              {canReview && <> <button className="small ghost" onClick={() => run(async () => { await api.patch(`/api/projects/${project.id}/qa/${e.id}`, e.is_lesson ? { active: !e.active } : { is_lesson: true, active: true }); qa.reload(); })}>{e.is_lesson ? (e.active ? "Deactivate" : "Activate") : "Make lesson"}</button></>}
            </td>
          </tr>
        ))}</tbody>
      </table>
      <div className="card">
        <h3>Global visualization rules</h3>
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{(qa.data?.global || []).map((e: any) => <li key={e.id} style={!e.active ? { opacity: .5 } : undefined}>{e.title}</li>)}</ul>
        {!user.is_admin && <div className="dim" style={{ marginTop: 6 }}>Global rules are managed by administrators in Team & settings.</div>}
      </div>
    </div>
  );
}
