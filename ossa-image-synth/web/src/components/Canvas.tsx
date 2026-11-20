import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge, Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow, useEdgesState, useNodesState,
  type Connection, type Edge, type Node, type NodeChange,
} from "@xyflow/react";
import { api } from "../api";
import { useP } from "../ctx";
import type { ModuleKey, ModuleState } from "../types";
import ModuleNode, { type ModuleNodeData } from "./ModuleNode";

const KEYS: ModuleKey[] = ["N01", "N02", "N03", "N04", "N05", "N06", "N07", "N08", "N09"];
export const DEFAULT_POS: Record<ModuleKey, { x: number; y: number }> = {
  N09: { x: 0, y: 260 }, N01: { x: 380, y: 0 }, N02: { x: 380, y: 230 }, N03: { x: 380, y: 460 }, N05: { x: 380, y: 700 },
  N04: { x: 760, y: 260 }, N07: { x: 1140, y: 380 }, N08: { x: 1520, y: 380 }, N06: { x: 1140, y: 700 },
};
/** Dependencies that the readiness rules enforce. */
export const DEPENDENCIES: [ModuleKey, ModuleKey, string][] = [
  ["N09", "N01", "documents"], ["N09", "N02", "finish docs"], ["N09", "N03", "equipment docs"], ["N09", "N05", "source images"],
  ["N01", "N04", "project facts"], ["N02", "N04", "approved finishes"], ["N03", "N04", "approved equipment"],
  ["N05", "N04", "image + masks"], ["N04", "N07", "approved intent"], ["N05", "N07", "protected source"],
  ["N07", "N08", "generated output"], ["N05", "N08", "original for comparison"], ["N08", "N06", "decisions"], ["N06", "N04", "lessons"],
];
const COLOR: Record<ModuleState, string> = {
  EMPTY: "#5b6570", PROCESSING: "#4aa3df", NEEDS_REVIEW: "#e0a43a", VALIDATED: "#3fb67a", ERROR: "#e5534b",
};
const nodeTypes = { module: ModuleNode };

export default function Canvas({ selected, onSelect }: { selected: ModuleKey | null; onSelect: (k: ModuleKey) => void }) {
  const { project, modules, canEdit, toast } = useP();
  const saved = project.canvas || {};
  const savedNodes: Record<string, any> = Object.fromEntries((saved.nodes || []).map((n: any) => [n.id, n]));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(
    () => Object.fromEntries((saved.nodes || []).map((n: any) => [n.id, !!n.collapsed])));

  const initialNodes: Node<ModuleNodeData>[] = KEYS.map((k) => ({
    id: k, type: "module", position: savedNodes[k]?.position || DEFAULT_POS[k],
    width: savedNodes[k]?.width || 300, height: savedNodes[k]?.height || 190,
    data: { k, info: null, collapsed: false, onToggle: () => {}, onOpen: () => {} },
  }));
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ModuleNodeData>>(initialNodes);
  const [manualEdges, setManualEdges] = useState<Edge[]>(() => (saved.edges || []).map((e: any) => ({ ...e })));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const saveTimer = useRef<number>();

  const persist = useCallback((ns: Node[], manual: Edge[], coll: Record<string, boolean>) => {
    if (!canEdit) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const canvas = {
        nodes: ns.map((n) => ({ id: n.id, position: n.position, width: n.width, height: n.height, collapsed: !!coll[n.id] })),
        edges: manual.map((e) => ({ id: e.id, source: e.source, target: e.target })),
      };
      api.put(`/api/projects/${project.id}/canvas`, { canvas }).catch(() => toast("Could not save canvas layout", "err"));
    }, 500);
  }, [canEdit, project.id, toast]);

  // Inject live module info into node data.
  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({
      ...n,
      selected: n.id === selected,
      data: {
        ...n.data,
        info: modules ? modules[n.id as ModuleKey] : null,
        collapsed: !!collapsed[n.id],
        onToggle: () => setCollapsed((c) => ({ ...c, [n.id]: !c[n.id] })),
        onOpen: () => onSelect(n.id as ModuleKey),
      },
    })));
  }, [modules, collapsed, selected, onSelect, setNodes]);

  // Build cable list: enforced dependencies (coloured by upstream state) + manual cables.
  useEffect(() => {
    const dep: Edge[] = DEPENDENCIES.map(([s, t, label]) => {
      const st = modules?.[s]?.state || "EMPTY";
      return {
        id: `dep-${s}-${t}`, source: s, target: t, sourceHandle: "out", targetHandle: "in", label, deletable: false,
        type: "smoothstep", animated: st === "PROCESSING",
        style: { stroke: COLOR[st], strokeWidth: 2.2, strokeDasharray: st === "EMPTY" ? "6 5" : undefined },
        labelStyle: { fill: "#9aa4ae", fontSize: 10 }, labelBgStyle: { fill: "#0d1013" },
        markerEnd: { type: MarkerType.ArrowClosed, color: COLOR[st] },
        data: { kind: "dependency" },
      };
    });
    const man: Edge[] = manualEdges.map((e) => ({
      ...e, type: "smoothstep", deletable: true, label: "manual", sourceHandle: "out", targetHandle: "in",
      style: { stroke: "#d8b26e", strokeWidth: 1.6, strokeDasharray: "3 4" }, labelStyle: { fill: "#d8b26e", fontSize: 10 },
      labelBgStyle: { fill: "#0d1013" }, markerEnd: { type: MarkerType.ArrowClosed, color: "#d8b26e" }, data: { kind: "manual" },
    }));
    setEdges([...dep, ...man]);
  }, [modules, manualEdges, setEdges]);

  useEffect(() => { persist(nodes, manualEdges, collapsed); }, [collapsed]); // eslint-disable-line

  const onConnect = useCallback((c: Connection) => {
    if (!canEdit) return;
    if (c.source === c.target) return;
    if (DEPENDENCIES.some(([s, t]) => s === c.source && t === c.target)) {
      toast("That connection already exists as an enforced dependency", "info");
      return;
    }
    setManualEdges((m) => {
      const next = addEdge({ ...c, id: `man-${c.source}-${c.target}-${Date.now()}` }, m) as Edge[];
      persist(nodes, next, collapsed);
      return next;
    });
  }, [canEdit, nodes, collapsed, persist, toast]);

  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    const ids = new Set(deleted.map((d) => d.id));
    setManualEdges((m) => {
      const next = m.filter((e) => !ids.has(e.id));
      persist(nodes, next, collapsed);
      return next;
    });
  }, [nodes, collapsed, persist]);

  // Persist after a resize finishes (dimension change with resizing=false).
  const handleNodesChange = useCallback((changes: NodeChange<Node<ModuleNodeData>>[]) => {
    onNodesChange(changes);
    if (changes.some((c) => c.type === "dimensions" && (c as any).resizing === false)) {
      setNodes((ns) => { persist(ns, manualEdges, collapsed); return ns; });
    }
  }, [onNodesChange, setNodes, persist, manualEdges, collapsed]);

  const autoLayout = () => {
    const ns = nodes.map((n) => ({ ...n, position: DEFAULT_POS[n.id as ModuleKey], width: 300, height: 190 }));
    setNodes(ns);
    setCollapsed({});
    setManualEdges([]);
    persist(ns, [], {});
    toast("Layout and cables reset to the automatic configuration", "ok");
  };

  const legend = useMemo(() => (Object.keys(COLOR) as ModuleState[]), []);

  return (
    <div style={{ position: "absolute", inset: 0 }} data-testid="canvas">
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={handleNodesChange} onEdgesChange={onEdgesChange}
        onConnect={onConnect} onEdgesDelete={onEdgesDelete} fitView minZoom={0.2} maxZoom={2}
        onNodeDragStop={() => setNodes((ns) => { persist(ns, manualEdges, collapsed); return ns; })}
        onNodeDoubleClick={(_, n) => onSelect(n.id as ModuleKey)}
        nodesDraggable={true} nodesConnectable={canEdit} proOptions={{ hideAttribution: true }}
        onNodesDelete={() => {}} deleteKeyCode={["Backspace", "Delete"]}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#2a3139" />
        <Controls />
        <MiniMap pannable zoomable nodeColor={(n) => COLOR[(modules?.[n.id as ModuleKey]?.state || "EMPTY") as ModuleState]} maskColor="rgba(0,0,0,.55)" />
      </ReactFlow>
      <div className="card" style={{ position: "absolute", left: 12, top: 12, padding: "6px 10px", display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", fontSize: 11, maxWidth: "calc(100% - 24px)", zIndex: 5 }}>
        {legend.map((s) => <span key={s} className={`row s-${s}`} style={{ gap: 4 }}><span className="dot st" />{s.replace("_", " ")}</span>)}
        <span className="row" style={{ gap: 4, color: "#d8b26e" }}>┄ manual cable</span>
        {canEdit && <button className="small" onClick={autoLayout} title="Reset node layout and remove manual cables">Auto-connect / reset layout</button>}
      </div>
    </div>
  );
}
