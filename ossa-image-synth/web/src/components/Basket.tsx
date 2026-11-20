import { useRef, useState } from "react";
import { api, errText } from "../api";
import { useP } from "../ctx";
import type { ModuleKey } from "../types";
import { StateDot } from "./bits";

// What to put in the basket for each module, in plain words.
const NEEDS: Record<string, { what: string; docs: string }> = {
  N01: { what: "Project Understanding", docs: "project description, plans, elevations or sections" },
  N02: { what: "Finish Schedule", docs: "the finish schedule (PDF, Excel or CSV)" },
  N03: { what: "Equipment & Food Service", docs: "the equipment schedule and the equipment plan, if the project has food service equipment" },
  N05: { what: "Source Images", docs: "the Enscape renders you want to edit" },
};
const ORDER: ModuleKey[] = ["N01", "N02", "N03", "N05"];

export default function Basket({ onOpen }: { onOpen: (k: ModuleKey) => void }) {
  const { project, modules, canEdit, toast, refresh } = useP();
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    setBusy(`Reading ${files.length} file${files.length > 1 ? "s" : ""}…`);
    try {
      const res = await api.post<any[]>(`/api/projects/${project.id}/documents`, fd);
      const bad = res.filter((r) => r.error);
      bad.forEach((r) => toast(`${r.name}: ${r.error}`, r.skipped ? "info" : "err"));
      if (res.length > bad.length) toast(`${res.length - bad.length} file(s) read. Check the list to see which modules they cover.`, "ok");
    } catch (e) { toast(errText(e), "err"); } finally { setBusy(""); refresh(); }
  };

  if (!modules) return null;
  const docModules = ORDER.map((k) => ({ k, m: modules[k] }));
  const done = docModules.filter((x) => x.m.state === "VALIDATED").length;

  return (
    <div className={"basket card" + (over ? " over" : "")} data-testid="basket"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (canEdit) upload([...e.dataTransfer.files]); }}>
      <div className="row">
        <h3>Project documents</h3>
        <span className="muted">{done} of {ORDER.length} covered</span>
        <div className="spacer" />
        <button className="small ghost" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Expand" : "Collapse"}>{collapsed ? "▸" : "▾"}</button>
      </div>
      {!collapsed && (
        <>
          {canEdit && (
            <div className="drop basket-drop" onClick={() => input.current?.click()} data-testid="basket-drop">
              <b>{busy || "Drop all your project files here"}</b>
              <div className="dim">Drawings, schedules, specs and renders, all together. Image Synth sorts them into the right modules.</div>
              <input ref={input} type="file" multiple hidden data-testid="basket-input" onChange={(e) => { upload([...(e.target.files || [])]); e.target.value = ""; }} />
            </div>
          )}
          <div className="col" style={{ gap: 6 }}>
            {docModules.map(({ k, m }) => (
              <button key={k} className="basket-row" onClick={() => onOpen(k)}>
                <StateDot state={m.state} />
                <div style={{ minWidth: 0, textAlign: "left" }}>
                  <div><b>{NEEDS[k].what}</b> <span className="dim">{m.state === "VALIDATED" ? "covered" : m.state === "EMPTY" ? "nothing yet" : m.state === "ERROR" ? "problem" : "needs your review"}</span></div>
                  <div className="dim basket-hint">
                    {m.state === "EMPTY" ? `Add ${NEEDS[k].docs}.`
                      : m.state === "VALIDATED" ? "All required information approved."
                      : m.missing[0] ? `Next: ${m.missing[0]}` : "Review and approve what was found."}
                  </div>
                </div>
              </button>
            ))}
          </div>
          <button className="small ghost" onClick={() => onOpen("N09")}>See all uploaded files</button>
          {done === ORDER.length && <div className="ok-box">All document modules are covered. Next: describe your edit in Visual Intent.</div>}
        </>
      )}
    </div>
  );
}
