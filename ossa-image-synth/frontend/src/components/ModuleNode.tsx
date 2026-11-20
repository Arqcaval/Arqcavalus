import { memo } from "react";
import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import type { ModuleInfo, ModuleKey } from "../types";
import { StateBadge } from "./bits";

export type ModuleNodeData = {
  k: ModuleKey;
  info: ModuleInfo | null;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: () => void;
};

const TITLES: Record<ModuleKey, string> = {
  N01: "Project Understanding", N02: "Finish Schedule Intelligence", N03: "Equipment & Food Service Intelligence",
  N04: "Visual Intent Engine", N05: "Source Image Integrity", N06: "Learning & QA Log", N07: "Oscillator / AI Engine",
  N08: "Output & Validation", N09: "Document Intake & Module Mapping",
};

function ModuleNode({ data, selected }: NodeProps<Node<ModuleNodeData>>) {
  const { k, info, collapsed } = data;
  const state = info?.state || "EMPTY";
  return (
    <>
      <NodeResizer isVisible={selected && !collapsed} minWidth={240} minHeight={110} lineStyle={{ borderColor: "#7cc4ff" }} handleStyle={{ width: 8, height: 8 }} />
      <div className={`mnode s-${state}` + (selected ? " selected" : "")} style={collapsed ? { height: "auto" } : undefined} data-testid={`node-${k}`}>
        <Handle type="target" position={Position.Left} id="in" />
        <div className="hd">
          <span className="num">NODE {k.slice(1)}</span>
          <span className="title" title={TITLES[k]}>{TITLES[k]}</span>
          <StateBadge state={state} />
          <button className="small ghost nodrag" onClick={data.onToggle} title={collapsed ? "Expand" : "Collapse"}>{collapsed ? "▸" : "▾"}</button>
        </div>
        {!collapsed && (
          <div className="bd nowheel">
            <div className="row" style={{ marginBottom: 4 }}>
              {info?.critical === true && <span className="crit">critical</span>}
              {info?.critical === "conditional" && <span className="crit" title="Critical when the edit intent requires it">conditional</span>}
              {k === "N07" && info?.mode && <span className="crit">mode: {info.mode.toUpperCase()}</span>}
              <div className="spacer" />
              <button className="small nodrag" onClick={data.onOpen}>Open</button>
            </div>
            {info ? info.requirements.map((r) => (
              <div className="req" key={r.id}>
                <span className="ic" style={{ color: r.satisfied ? "var(--ok)" : r.required ? "var(--err)" : "var(--dim)" }}>{r.satisfied ? "✓" : r.required ? "✕" : "○"}</span>
                <span className={r.satisfied ? "" : "muted"}>{r.label}</span>
              </div>
            )) : <div className="muted">…</div>}
            {info?.last_job_error && <div className="err-box" style={{ marginTop: 6, fontSize: 11 }}>{info.last_job_error}</div>}
          </div>
        )}
        <Handle type="source" position={Position.Right} id="out" />
      </div>
    </>
  );
}
export default memo(ModuleNode);
