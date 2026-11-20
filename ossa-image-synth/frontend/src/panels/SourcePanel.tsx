import { useState } from "react";
import { api, fileUrl } from "../api";
import { useP } from "../ctx";
import type { SourceImage } from "../types";
import { StatusPill, useAction, useLoad } from "../components/bits";
import MaskEditor from "./MaskEditor";

export default function SourcePanel() {
  const { project, canEdit, open } = useP();
  const imgs = useLoad<SourceImage[]>(() => api.get(`/api/projects/${project.id}/images`), [project.id]);
  const { run } = useAction();
  const [maskFor, setMaskFor] = useState<SourceImage | null>(null);
  const [verify, setVerify] = useState<Record<string, any>>({});
  const [analysis, setAnalysis] = useState<Record<string, string>>({});

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="info-box">Source images are stored write-once and verified by SHA-256 before every run. Image Synth never modifies them; outputs are stored as separate versions.</div>
      {imgs.data?.length === 0 && <div className="muted">No source images. Upload renders in <a href="#" onClick={(e) => { e.preventDefault(); open("N09"); }}>Document Intake</a>.</div>}
      {maskFor && <MaskEditor image={maskFor} onDone={() => { setMaskFor(null); imgs.reload(); }} />}
      <div className="thumbs" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
        {(imgs.data || []).map((i) => (
          <div key={i.id} className="card col" style={{ gap: 6 }} data-testid={`image-${i.label}`}>
            <img src={fileUrl(`/api/projects/${project.id}/images/${i.id}/file`, { thumb: true })} alt={i.label} />
            <div className="row"><b style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{i.label}</b><div className="spacer" /><StatusPill status={i.status} /></div>
            <div className="dim mono">{i.width}×{i.height} · sha {i.sha256.slice(0, 12)}…</div>
            {verify[i.id] && <div className={verify[i.id].unchanged ? "ok-box" : "err-box"} style={{ fontSize: 11 }}>{verify[i.id].unchanged ? "Verified: stored file identical to the original upload" : "HASH MISMATCH"}</div>}
            <div className="row">
              {canEdit && i.status !== "authorized" && <button className="small ok" onClick={() => run(async () => { await api.patch(`/api/projects/${project.id}/images/${i.id}`, { status: "authorized" }); imgs.reload(); }, "Authorised as source")}>Authorise as source</button>}
              {canEdit && i.status === "authorized" && <button className="small" onClick={() => run(async () => { await api.patch(`/api/projects/${project.id}/images/${i.id}`, { status: "candidate" }); imgs.reload(); })}>Revoke</button>}
              <button className="small" onClick={async () => setVerify({ ...verify, [i.id]: await api.get(`/api/projects/${project.id}/images/${i.id}/verify`) })}>Verify hash</button>
              {canEdit && <button className="small" onClick={() => setMaskFor(i)}>Draw mask</button>}
              {canEdit && <button className="small ghost" title="Advisory AI description, stored as an unreviewed AI assumption" onClick={() => run(async () => {
                const r = await api.post(`/api/projects/${project.id}/images/${i.id}/analyze`);
                setAnalysis({ ...analysis, [i.id]: r.data.text });
              }, "AI analysis stored as an AI assumption (not a fact)")}>AI analysis</button>}
            </div>
            {analysis[i.id] && <div className="card" style={{ fontSize: 11, whiteSpace: "pre-wrap" }}><span className="pill ai">AI assumption</span> {analysis[i.id]}</div>}
            {i.masks.length > 0 && (
              <table className="t"><tbody>
                {i.masks.map((m) => (
                  <tr key={m.id}>
                    <td><span className={m.kind === "edit" ? "pill ok" : "pill err"}>{m.kind}</span></td>
                    <td>{m.label}<div className="dim">{m.coverage.toFixed(1)}% of image</div></td>
                    <td><a href={fileUrl(`/api/projects/${project.id}/masks/${m.id}/file`)} target="_blank" rel="noreferrer">view</a></td>
                    <td><StatusPill status={m.status} /></td>
                    <td>{canEdit && m.status !== "approved" && <button className="small ok" onClick={() => run(async () => { await api.patch(`/api/projects/${project.id}/masks/${m.id}`, { status: "approved" }); imgs.reload(); }, "Mask approved")}>Approve</button>}</td>
                  </tr>
                ))}
              </tbody></table>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
