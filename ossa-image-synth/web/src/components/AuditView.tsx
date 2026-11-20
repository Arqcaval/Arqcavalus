import { api } from "../api";
import { useP } from "../ctx";
import { useLoad } from "./bits";

export default function AuditView() {
  const { project } = useP();
  const a = useLoad<any>(() => api.get(`/api/projects/${project.id}/audit`), [project.id]);
  return (
    <div className="page-scroll col">
      <div className="card">
        <h3>Activity log</h3>
        <div className="dim" style={{ margin: "4px 0 8px" }}>Every upload, review, run and decision in this project.</div>
        <div style={{ overflowX: "auto" }}>
          <table className="t"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
            <tbody>{(a.data?.events || []).map((e: any) => (
              <tr key={e.id}><td className="dim" style={{ whiteSpace: "nowrap" }}>{new Date(e.created_at).toLocaleString()}</td><td>{e.user || "—"}</td><td className="mono">{e.action}</td>
                <td className="mono" style={{ fontSize: 10 }}>{JSON.stringify(e.detail).slice(0, 300)}</td></tr>
            ))}{!a.data?.events?.length && <tr><td colSpan={4} className="muted">Nothing recorded yet.</td></tr>}</tbody></table>
        </div>
      </div>
    </div>
  );
}
