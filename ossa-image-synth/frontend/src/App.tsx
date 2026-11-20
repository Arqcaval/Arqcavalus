import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, auth, errText } from "./api";
import { ProjectCtx } from "./ctx";
import type { ModuleInfo, ModuleKey, Project, User } from "./types";
import Login from "./components/Login";
import Canvas from "./components/Canvas";
import Readiness from "./components/Readiness";
import Inspector from "./components/Inspector";
import Admin from "./components/Admin";
import AuditView from "./components/AuditView";
import { StateDot } from "./components/bits";

type View = "canvas" | "admin" | "audit";

const NAV: { key: ModuleKey; label: string }[] = [
  { key: "N09", label: "Document Intake" },
  { key: "N01", label: "Project Understanding" },
  { key: "N02", label: "Finish Schedule" },
  { key: "N03", label: "Equipment & Food Service" },
  { key: "N05", label: "Source Images & Masks" },
  { key: "N04", label: "Visual Intent" },
  { key: "N07", label: "Oscillator / AI Engine" },
  { key: "N08", label: "Output & Validation" },
  { key: "N06", label: "Learning & QA Log" },
];

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checked, setChecked] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [pid, setPid] = useState<string | null>(() => {
    try { return localStorage.getItem("is_project"); } catch { return null; }
  });
  const [project, setProject] = useState<Project | null>(null);
  const [modules, setModules] = useState<Record<ModuleKey, ModuleInfo> | null>(null);
  const [inspect, setInspect] = useState<ModuleKey | null>(null);
  const [wide, setWide] = useState(false);
  const [view, setView] = useState<View>("canvas");
  const [toastMsg, setToastMsg] = useState<{ msg: string; kind: string } | null>(null);
  const [tick, setTick] = useState(0);
  const toastTimer = useRef<number>();

  const toast = useCallback((msg: string, kind: "ok" | "err" | "info" = "info") => {
    setToastMsg({ msg, kind });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), kind === "err" ? 9000 : 3500);
  }, []);

  useEffect(() => {
    auth.onUnauthorized(() => setUser(null));
    if (!auth.token) { setChecked(true); return; }
    api.get<User>("/api/auth/me").then(setUser).catch(() => auth.set(null)).finally(() => setChecked(true));
  }, []);

  const loadProjects = useCallback(async () => {
    const ps = await api.get<Project[]>("/api/projects");
    setProjects(ps);
    return ps;
  }, []);

  useEffect(() => {
    if (!user) return;
    loadProjects().then((ps) => {
      if (!pid || !ps.find((p) => p.id === pid)) setPid(ps[0]?.id ?? null);
    }).catch((e) => toast(errText(e), "err"));
  }, [user]); // eslint-disable-line

  const reloadProject = useCallback(async () => {
    if (!pid) return;
    setProject(await api.get<Project>(`/api/projects/${pid}`));
  }, [pid]);

  const refresh = useCallback(async () => {
    if (!pid) return;
    try {
      const r = await api.get(`/api/projects/${pid}/modules`);
      setModules(r.modules);
      setTick((t) => t + 1);
    } catch (e) {
      toast(errText(e), "err");
    }
  }, [pid, toast]);

  useEffect(() => {
    if (!pid || !user) return;
    try { localStorage.setItem("is_project", pid); } catch { /* ignore */ }
    setModules(null);
    setProject(null);
    reloadProject().catch((e) => toast(errText(e), "err"));
    refresh();
  }, [pid, user]); // eslint-disable-line

  // Poll while anything is processing.
  useEffect(() => {
    if (!modules) return;
    const busy = Object.values(modules).some((m) => m.state === "PROCESSING");
    const t = window.setTimeout(refresh, busy ? 1500 : 8000);
    return () => window.clearTimeout(t);
  }, [modules, refresh]);

  const ctx = useMemo(() => {
    if (!user || !project) return null;
    const rank: Record<string, number> = { viewer: 0, reviewer: 1, editor: 2, owner: 3 };
    return {
      user, project, modules, refresh, reloadProject, toast, tick,
      open: (k: ModuleKey) => { setView("canvas"); setInspect(k); },
      canEdit: rank[project.role] >= 2,
      canReview: rank[project.role] >= 1,
    };
  }, [user, project, modules, refresh, reloadProject, toast, tick]);

  if (!checked) return null;
  if (!user) return <Login onLogin={(u) => setUser(u)} />;

  const createProject = async () => {
    const name = prompt("New project name");
    if (!name) return;
    try {
      const p = await api.post<Project>("/api/projects", { name });
      await loadProjects();
      setPid(p.id);
      toast("Project created", "ok");
    } catch (e) { toast(errText(e), "err"); }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><b>OSSA STUDIO</b><span>IMAGE SYNTH</span></div>
        <div className="dim">|</div>
        <div style={{ fontWeight: 600 }}>{project?.name ?? "No project selected"}</div>
        {project?.is_reference && <span className="pill warn" title="Reference records are not universal defaults">reference configuration</span>}
        <div className="spacer" />
        {project && <span className="muted">Budget ${project.spent_usd.toFixed(2)} / ${project.budget_usd.toFixed(2)}</span>}
        {project && <a className="small" href={`/api/projects/${project.id}/export?token=${auth.token}`}>Export</a>}
        <span className="muted">{user.email}{project ? ` · ${project.role}` : ""}</span>
        <button className="small" onClick={async () => { await api.post("/api/auth/logout").catch(() => {}); auth.set(null); setUser(null); }}>Sign out</button>
      </header>
      <div className="main">
        <aside className="sidebar">
          <div>
            <div className="row"><h4 style={{ margin: 0 }}>Projects</h4><div className="spacer" /><button className="small" onClick={createProject}>+ New</button></div>
            <div className="col" style={{ gap: 2, marginTop: 6 }}>
              {projects.map((p) => (
                <div key={p.id} className={"proj" + (p.id === pid ? " active" : "")} onClick={() => { setPid(p.id); setInspect(null); setView("canvas"); }}>
                  <div style={{ fontWeight: 500 }}>{p.name}</div>
                  <div className="dim" style={{ fontSize: 11 }}>{p.code || "—"} · {p.role}</div>
                </div>
              ))}
              {!projects.length && <div className="muted">No projects yet.</div>}
            </div>
          </div>
          {project && (
            <div className="nav">
              <h4>Modules</h4>
              <button className={view === "canvas" && !inspect ? "active" : ""} onClick={() => { setView("canvas"); setInspect(null); }}>◇ Node canvas</button>
              {NAV.map((n) => (
                <button key={n.key} className={inspect === n.key && view === "canvas" ? "active" : ""} onClick={() => { setView("canvas"); setInspect(n.key); }}>
                  {modules ? <StateDot state={modules[n.key].state} /> : <span className="dot" />}
                  <span className="dim mono">{n.key.replace("N", "")}</span> {n.label}
                </button>
              ))}
              <h4>Records</h4>
              <button className={view === "audit" ? "active" : ""} onClick={() => setView("audit")}>Audit & provider calls</button>
              <button className={view === "admin" ? "active" : ""} onClick={() => setView("admin")}>Team & settings</button>
            </div>
          )}
        </aside>
        {ctx ? (
          <ProjectCtx.Provider value={ctx}>
            <section className="workspace">
              <Readiness />
              <div className="canvas-wrap">
                {view === "canvas" && <Canvas selected={inspect} onSelect={setInspect} />}
                {view === "canvas" && inspect && <Inspector k={inspect} wide={wide} setWide={setWide} onClose={() => setInspect(null)} />}
                {view === "admin" && <Admin onProjectsChanged={loadProjects} />}
                {view === "audit" && <AuditView />}
              </div>
            </section>
          </ProjectCtx.Provider>
        ) : (
          <section className="workspace" style={{ placeItems: "center", display: "grid" }}>
            <div className="muted">{projects.length ? "Loading project…" : "Create a project to begin."}</div>
          </section>
        )}
      </div>
      {toastMsg && <div className={"toast " + (toastMsg.kind === "err" ? "err-box" : toastMsg.kind === "ok" ? "ok-box" : "info-box")} onClick={() => setToastMsg(null)}>{toastMsg.msg}</div>}
    </div>
  );
}
