import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProjectCtx } from "./ctx";
import type { ModuleKey } from "./types";
import { route, store } from "./store";
import { evaluate } from "./engine/rules";
import Canvas from "./components/Canvas";
import Readiness from "./components/Readiness";
import Inspector from "./components/Inspector";
import Admin from "./components/Admin";
import AuditView from "./components/AuditView";
import { StateDot } from "./components/bits";

type View = "canvas" | "admin" | "audit";
const NAV: { key: ModuleKey; label: string }[] = [
  { key: "N09", label: "Document Intake" }, { key: "N01", label: "Project Understanding" }, { key: "N02", label: "Finish Schedule" },
  { key: "N03", label: "Equipment & Food Service" }, { key: "N05", label: "Source Images & Masks" }, { key: "N04", label: "Visual Intent" },
  { key: "N07", label: "AI Engine (Oscillator)" }, { key: "N08", label: "Output & Validation" }, { key: "N06", label: "Learning & QA Log" },
];
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export default function App() {
  const [, setVer] = useState(0);
  const [tick, setTick] = useState(0);
  const [pid, setPid] = useState<string | null>(() => lsGet("is_project"));
  const [inspect, setInspect] = useState<ModuleKey | null>(null);
  const [wide, setWide] = useState(false);
  const [view, setView] = useState<View>("canvas");
  const [toastMsg, setToastMsg] = useState<{ msg: string; kind: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const toastTimer = useRef<number>();

  const toast = useCallback((msg: string, kind: "ok" | "err" | "info" = "info") => {
    setToastMsg({ msg, kind });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), kind === "err" ? 9000 : 3500);
  }, []);

  useEffect(() => {
    const off = store.on(() => { setVer((v) => v + 1); setTick((t) => t + 1); });
    store.init();
    return () => { off(); };
  }, []);

  const projects = store.projects;
  useEffect(() => {
    if (!store.ready) return;
    if (!pid || !projects.find((p) => p.id === pid)) setPid(projects[0]?.id ?? null);
  }, [store.ready, projects.length]); // eslint-disable-line
  useEffect(() => { store.select(pid); if (pid) lsSet("is_project", pid); }, [pid, store.ready]);

  const project = pid ? projects.find((p) => p.id === pid) : null;
  const modules = useMemo(() => (project ? (evaluate(store.s) as any) : null), [tick, project?.id]); // eslint-disable-line

  const ctx = useMemo(() => {
    if (!project) return null;
    return {
      user: { id: "me", email: store.me || "you", name: store.me, is_admin: store.canWrite },
      project: { ...project, role: store.canWrite ? "owner" : "viewer", budget_usd: 0, spent_usd: 0 },
      modules, tick, toast,
      refresh: async () => setTick((t) => t + 1),
      reloadProject: async () => setTick((t) => t + 1),
      open: (k: ModuleKey) => { setView("canvas"); setInspect(k); },
      canEdit: store.canWrite, canReview: store.canWrite,
    } as any;
  }, [project, modules, tick, toast]);

  const createProject = async () => {
    if (!newName.trim()) return;
    try {
      const r = await route("POST", "/api/projects", { name: newName });
      setNewName(""); setCreating(false); setPid(r.id); setInspect("N09");
      toast("Project created. Start by adding its documents.", "ok");
    } catch (e: any) { toast(String(e?.message || e), "err"); }
  };

  const exportProject = async () => {
    if (!store.downloads) { toast("Saving files is not available in this view.", "err"); return; }
    const s = store.s;
    const data = JSON.stringify({ format: "ossa-image-synth-export/1", exported_at: new Date().toISOString(), project, documents: s.documents.map(({ text_excerpt, ...d }) => d),
      records: s.records, source_images: s.images, edit_requests: s.requests, runs: s.runs, outputs: s.outputs, qa_log: s.qa, audit: s.audit }, null, 2);
    try { await store.downloads.save({ filename: `${(project?.code || project?.name || "project").replace(/[^\w]+/g, "_")}_image_synth.json`, data }); }
    catch (e: any) { if (e?.code !== "declined") toast(String(e?.message || e), "err"); }
  };

  if (store.failed && !store.ready) return <div className="center-msg"><div className="card col"><div className="brand"><b>OSSA STUDIO</b><span>IMAGE SYNTH</span></div><p>{store.failed}</p></div></div>;
  if (!store.ready) return <div className="center-msg"><div className="col" style={{ alignItems: "center" }}><div className="brand"><b>OSSA STUDIO</b><span>IMAGE SYNTH</span></div><p className="muted">Opening your projects…</p></div></div>;

  const pick = (id: string) => { setPid(id); setInspect(null); setView("canvas"); setNavOpen(false); };
  return (
    <div className="app">
      <header className="topbar">
        <button className="small ghost menu-btn" aria-label="Menu" onClick={() => setNavOpen(!navOpen)}>☰</button>
        <div className="brand"><b>OSSA STUDIO</b><span>IMAGE SYNTH</span></div>
        <div className="dim hide-sm">|</div>
        <div className="proj-name">{project?.name ?? "No project selected"}</div>
        {project?.is_reference && <span className="pill warn hide-sm" title="Reference records must be confirmed against the project's documents">reference configuration</span>}
        <div className="spacer" />
        {!store.canWrite && <span className="pill">view only</span>}
        {project && <button className="small" onClick={exportProject}>Export</button>}
      </header>
      <div className={"main" + (navOpen ? " nav-open" : "")}>
        <aside className="sidebar">
          <div>
            <div className="row"><h4 style={{ margin: 0 }}>Projects</h4><div className="spacer" />{store.canWrite && <button className="small" onClick={() => setCreating(!creating)}>+ New</button>}</div>
            {creating && (
              <form className="col" style={{ gap: 6, marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); createProject(); }}>
                <input id="new-project" autoFocus placeholder="Project name" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <button className="primary small" type="submit">Create project</button>
              </form>
            )}
            <div className="col" style={{ gap: 2, marginTop: 6 }}>
              {projects.map((p) => (
                <div key={p.id} className={"proj" + (p.id === pid ? " active" : "")} onClick={() => pick(p.id)}>
                  <div style={{ fontWeight: 500 }}>{p.name}</div>
                  <div className="dim" style={{ fontSize: 11 }}>{p.code || "—"}</div>
                </div>
              ))}
            </div>
          </div>
          {project && (
            <div className="nav">
              <h4>Modules</h4>
              <button className={view === "canvas" && !inspect ? "active" : ""} onClick={() => { setView("canvas"); setInspect(null); setNavOpen(false); }}>◇ Node canvas</button>
              {NAV.map((n) => (
                <button key={n.key} className={inspect === n.key && view === "canvas" ? "active" : ""} onClick={() => { setView("canvas"); setInspect(n.key); setNavOpen(false); }}>
                  {modules ? <StateDot state={modules[n.key].state} /> : <span className="dot" />}
                  <span className="dim mono">{n.key.replace("N", "")}</span> {n.label}
                </button>
              ))}
              <h4>Records</h4>
              <button className={view === "audit" ? "active" : ""} onClick={() => { setView("audit"); setNavOpen(false); }}>Activity log</button>
              <button className={view === "admin" ? "active" : ""} onClick={() => { setView("admin"); setNavOpen(false); }}>Settings & sharing</button>
            </div>
          )}
        </aside>
        {ctx ? (
          <ProjectCtx.Provider value={ctx}>
            <section className="workspace">
              <Readiness />
              <div className="canvas-wrap">
                {view === "canvas" && <Canvas key={project!.id} selected={inspect} onSelect={setInspect} />}
                {view === "canvas" && inspect && <Inspector k={inspect} wide={wide} setWide={setWide} onClose={() => setInspect(null)} />}
                {view === "admin" && <Admin onProjectsChanged={async () => {}} />}
                {view === "audit" && <AuditView />}
              </div>
            </section>
          </ProjectCtx.Provider>
        ) : (
          <section className="workspace empty-state">
            <div className="card col" style={{ gap: 10, maxWidth: 460 }}>
              <h3>Start your first project</h3>
              <p className="muted" style={{ margin: 0 }}>A project holds one job's drawings, finish schedule, renders and approved edits. Nothing is shared between projects.</p>
              {store.canWrite ? (
                <form className="row" onSubmit={(e) => { e.preventDefault(); createProject(); }}>
                  <input id="first-project" style={{ flex: 1, minWidth: 0 }} placeholder="e.g. Myers Park Halfway House" value={newName} onChange={(e) => setNewName(e.target.value)} />
                  <button className="primary" type="submit">Create</button>
                </form>
              ) : <p className="muted">You have view-only access. Ask the owner for Editor access to create projects.</p>}
            </div>
          </section>
        )}
      </div>
      {toastMsg && <div className={"toast " + (toastMsg.kind === "err" ? "err-box" : toastMsg.kind === "ok" ? "ok-box" : "info-box")} onClick={() => setToastMsg(null)}>{toastMsg.msg}</div>}
    </div>
  );
}
