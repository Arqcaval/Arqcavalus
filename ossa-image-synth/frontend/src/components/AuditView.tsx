import { api } from "../api";
import { useP } from "../ctx";
import { useLoad } from "./bits";

export default function AuditView() {
  const { project } = useP();
  const a = useLoad<any>(() => api.get(`/api/projects/${project.id}/audit`), [project.id]);
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "auto", padding: 16 }} className="col">
      <div className="card">
        <h3>Provider calls</h3>
        <div className="dim" style={{ marginBottom: 6 }}>Every request to an AI provider is recorded (parameters and sizes only — never keys or image bytes).</div>
        <table className="t"><thead><tr><th>When</th><th>User</th><th>Provider / model</th><th>Operation</th><th>HTTP</th><th>ms</th><th>Request</th><th>Response</th></tr></thead>
          <tbody>{(a.data?.provider_calls || []).map((c: any) => (
            <tr key={c.id}><td className="dim">{new Date(c.created_at).toLocaleString()}</td><td>{c.user}</td><td>{c.provider}/{c.model}</td><td>{c.operation}</td>
              <td><span className={c.response_status === 200 ? "pill ok" : "pill err"}>{c.response_status || "—"}</span></td><td>{c.duration_ms}</td>
              <td className="mono" style={{ fontSize: 10, maxWidth: 260 }}>{JSON.stringify(c.request_summary)}</td>
              <td className="mono" style={{ fontSize: 10, maxWidth: 260 }}>{JSON.stringify(c.response_summary).slice(0, 300)}</td></tr>
          ))}{!a.data?.provider_calls?.length && <tr><td colSpan={8} className="muted">No provider calls for this project.</td></tr>}</tbody></table>
      </div>
      <div className="card">
        <h3>Audit trail</h3>
        <table className="t"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead>
          <tbody>{(a.data?.events || []).map((e: any) => (
            <tr key={e.id}><td className="dim" style={{ whiteSpace: "nowrap" }}>{new Date(e.created_at).toLocaleString()}</td><td>{e.user}</td><td className="mono">{e.action}</td>
              <td className="mono" style={{ fontSize: 10 }}>{JSON.stringify(e.detail).slice(0, 400)}</td></tr>
          ))}</tbody></table>
      </div>
    </div>
  );
}
