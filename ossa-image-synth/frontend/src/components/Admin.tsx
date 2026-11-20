import { useEffect, useState } from "react";
import { api } from "../api";
import { useP } from "../ctx";
import { useAction, useLoad } from "./bits";

export default function Admin({ onProjectsChanged }: { onProjectsChanged: () => void }) {
  const { project, user, reloadProject } = useP();
  const isOwner = project.role === "owner";
  const members = useLoad<any[]>(() => api.get(`/api/projects/${project.id}/members`), [project.id]);
  const users = useLoad<any[]>(() => (user.is_admin ? api.get(`/api/admin/users`) : Promise.resolve([])), [user.is_admin]);
  const reg = useLoad<any>(() => api.get(`/api/oscillator/registry`), []);
  const qa = useLoad<any>(() => api.get(`/api/projects/${project.id}/qa`), [project.id]);
  const { run, busy } = useAction();
  const [p, setP] = useState({ name: project.name, code: project.code, description: project.description, budget_usd: project.budget_usd });
  const [m, setM] = useState({ email: "", role: "editor" });
  const [nu, setNu] = useState({ email: "", name: "", password: "", is_admin: false });
  const [regText, setRegText] = useState("");
  const [rule, setRule] = useState("");
  const [pw, setPw] = useState({ current_password: "", new_password: "" });
  useEffect(() => { if (reg.data) setRegText(JSON.stringify(reg.data, null, 2)); }, [reg.data]);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "auto", padding: 16 }} className="col">
      <div className="card col" style={{ gap: 8 }}>
        <h3>Project settings</h3>
        <div className="kv" style={{ gridTemplateColumns: "140px 1fr", gap: 6 }}>
          <span>Name</span><input disabled={!isOwner} value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
          <span>Code</span><input disabled={!isOwner} value={p.code} onChange={(e) => setP({ ...p, code: e.target.value })} />
          <span>Description</span><textarea disabled={!isOwner} value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} />
          <span>AI budget (USD)</span><input disabled={!isOwner} type="number" min={0} step={1} value={p.budget_usd} onChange={(e) => setP({ ...p, budget_usd: +e.target.value })} />
          <span>Spent (estimated)</span><span>${project.spent_usd.toFixed(2)}</span>
        </div>
        {isOwner && <div><button className="primary" disabled={busy} onClick={() => run(async () => { await api.patch(`/api/projects/${project.id}`, p); await reloadProject(); onProjectsChanged(); }, "Saved")}>Save</button></div>}
      </div>

      <div className="card col" style={{ gap: 8 }}>
        <h3>Project members</h3>
        <div className="dim">owner: everything · editor: upload, review records, draw masks, run jobs · reviewer: approve/reject outputs, QA log · viewer: read only</div>
        <table className="t"><tbody>{(members.data || []).map((x) => (
          <tr key={x.user_id}><td>{x.email}</td><td>{x.name}</td><td>{x.role}</td>
            <td>{isOwner && x.user_id !== user.id && <button className="small" onClick={() => run(async () => { await api.del(`/api/projects/${project.id}/members/${x.user_id}`); members.reload(); })}>Remove</button>}</td></tr>
        ))}</tbody></table>
        {isOwner && <div className="row">
          <input placeholder="user email" value={m.email} onChange={(e) => setM({ ...m, email: e.target.value })} />
          <select value={m.role} onChange={(e) => setM({ ...m, role: e.target.value })}>{["owner", "editor", "reviewer", "viewer"].map((r) => <option key={r}>{r}</option>)}</select>
          <button onClick={() => run(async () => { await api.post(`/api/projects/${project.id}/members`, m); setM({ ...m, email: "" }); members.reload(); }, "Member added")}>Add / update</button>
        </div>}
      </div>

      {user.is_admin && (
        <div className="card col" style={{ gap: 8 }}>
          <h3>User accounts (administrator)</h3>
          <table className="t"><thead><tr><th>Email</th><th>Name</th><th>Admin</th><th>Active</th><th /></tr></thead><tbody>{(users.data || []).map((x) => (
            <tr key={x.id}><td>{x.email}</td><td>{x.name}</td><td>{x.is_admin ? "yes" : ""}</td><td>{x.active ? "yes" : "disabled"}</td>
              <td>{x.id !== user.id && <button className="small" onClick={() => run(async () => { await api.patch(`/api/admin/users/${x.id}`, { active: !x.active }); users.reload(); })}>{x.active ? "Disable" : "Enable"}</button>}{" "}
                <button className="small ghost" onClick={() => { const np = prompt(`New password for ${x.email} (min 10 chars)`); if (np) run(() => api.patch(`/api/admin/users/${x.id}`, { password: np }), "Password set"); }}>Set password</button></td></tr>
          ))}</tbody></table>
          <div className="row">
            <input placeholder="email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} />
            <input placeholder="name" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} />
            <input placeholder="temporary password (≥10)" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
            <label className="row"><input type="checkbox" checked={nu.is_admin} onChange={(e) => setNu({ ...nu, is_admin: e.target.checked })} /> admin</label>
            <button onClick={() => run(async () => { await api.post(`/api/admin/users`, nu); setNu({ email: "", name: "", password: "", is_admin: false }); users.reload(); }, "User created — add them to projects as a member")}>Create user</button>
          </div>
        </div>
      )}

      <div className="card col" style={{ gap: 8 }}>
        <h3>Oscillator capability registry</h3>
        <div className="dim">Scores are OSSA evaluation scores (architectural fidelity), not release dates. A model is only used if it is listed here and discovered with the configured credentials. {user.is_admin ? "Edit carefully; saved to the server data directory." : "Read-only (administrators can edit)."}</div>
        <textarea className="mono" rows={18} value={regText} readOnly={!user.is_admin} onChange={(e) => setRegText(e.target.value)} />
        {user.is_admin && <div><button onClick={() => run(async () => { reg.setData(await api.put(`/api/oscillator/registry`, JSON.parse(regText))); }, "Registry saved")}>Save registry</button></div>}
      </div>

      {user.is_admin && (
        <div className="card col" style={{ gap: 8 }}>
          <h3>Global visualization rules</h3>
          {(qa.data?.global || []).map((e: any) => (
            <div key={e.id} className="row"><span style={!e.active ? { opacity: .5 } : undefined}>{e.title}</span><div className="spacer" />
              <button className="small ghost" onClick={() => run(async () => { await api.patch(`/api/qa/global/${e.id}`, { active: !e.active }); qa.reload(); })}>{e.active ? "Deactivate" : "Activate"}</button></div>
          ))}
          <div className="row"><input style={{ flex: 1 }} placeholder="New global rule" value={rule} onChange={(e) => setRule(e.target.value)} />
            <button disabled={!rule.trim()} onClick={() => run(async () => { await api.post(`/api/qa/global`, { category: "lesson", title: rule }); setRule(""); qa.reload(); }, "Rule added")}>Add rule</button></div>
        </div>
      )}

      <div className="card col" style={{ gap: 8 }}>
        <h3>My password</h3>
        <div className="row">
          <input type="password" placeholder="current" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} />
          <input type="password" placeholder="new (≥10 chars)" value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} />
          <button onClick={() => run(async () => { await api.post(`/api/auth/password`, pw); setPw({ current_password: "", new_password: "" }); }, "Password changed")}>Change</button>
        </div>
      </div>
    </div>
  );
}
