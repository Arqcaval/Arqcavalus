import { Img } from "../components/bits";
import { useEffect, useRef, useState } from "react";
import { api, errText, fileUrl } from "../api";
import { useP } from "../ctx";
import type { SourceImage } from "../types";

type Tool = "brush" | "rect" | "erase";

/** Paints a mask at the source image's native resolution. Painted = 255 in the uploaded PNG. */
export default function MaskEditor({ image, onDone }: { image: SourceImage; onDone: () => void }) {
  const { project, toast } = useP();
  const cv = useRef<HTMLCanvasElement>(null);
  const [kind, setKind] = useState<"edit" | "protected">("edit");
  const [tool, setTool] = useState<Tool>("rect");
  const [size, setSize] = useState(Math.round(Math.max(image.width, image.height) / 40));
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const drag = useRef<{ x: number; y: number; snap: ImageData } | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const color = kind === "edit" ? "rgb(40,200,120)" : "rgb(230,60,60)";

  useEffect(() => {
    const c = cv.current!;
    c.width = image.width;
    c.height = image.height;
  }, [image]);

  const pt = (e: React.PointerEvent) => {
    const r = cv.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * image.width, y: ((e.clientY - r.top) / r.height) * image.height };
  };
  const ctx = () => cv.current!.getContext("2d")!;
  const stroke = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const g = ctx();
    g.globalCompositeOperation = tool === "erase" ? "destination-out" : "source-over";
    g.strokeStyle = color; g.lineWidth = size; g.lineCap = "round";
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  };
  const down = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = pt(e);
    if (tool === "rect") drag.current = { ...p, snap: ctx().getImageData(0, 0, image.width, image.height) };
    else { last.current = p; stroke(p, p); }
  };
  const move = (e: React.PointerEvent) => {
    const p = pt(e);
    if (tool === "rect" && drag.current) {
      const g = ctx();
      g.putImageData(drag.current.snap, 0, 0);
      g.globalCompositeOperation = "source-over";
      g.fillStyle = color;
      g.fillRect(Math.min(drag.current.x, p.x), Math.min(drag.current.y, p.y), Math.abs(p.x - drag.current.x), Math.abs(p.y - drag.current.y));
    } else if (last.current) { stroke(last.current, p); last.current = p; }
  };
  const up = () => { drag.current = null; last.current = null; };
  const clear = () => ctx().clearRect(0, 0, image.width, image.height);

  const save = async () => {
    const c = cv.current!;
    const src = ctx().getImageData(0, 0, image.width, image.height);
    let painted = 0;
    const out = document.createElement("canvas");
    out.width = image.width; out.height = image.height;
    const og = out.getContext("2d")!;
    const od = og.createImageData(image.width, image.height);
    for (let i = 0; i < src.data.length; i += 4) {
      const v = src.data[i + 3] > 127 ? 255 : 0;
      if (v) painted++;
      od.data[i] = od.data[i + 1] = od.data[i + 2] = v; od.data[i + 3] = 255;
    }
    if (!painted) { toast("Paint a region first", "err"); return; }
    og.putImageData(od, 0, 0);
    const blob: Blob = await new Promise((res) => out.toBlob((b) => res(b!), "image/png"));
    const fd = new FormData();
    fd.append("kind", kind); fd.append("label", label || `${kind} mask`); fd.append("file", blob, "mask.png");
    setSaving(true);
    try {
      await api.post(`/api/projects/${project.id}/images/${image.id}/masks`, fd);
      toast(`${kind === "edit" ? "Edit" : "Protected"} area saved`, "ok");
      onDone();
    } catch (e) { toast(errText(e), "err"); } finally { setSaving(false); void c; }
  };

  return (
    <div className="card col" style={{ gap: 8 }} data-testid="mask-editor">
      <div className="row">
        <h3>Mask editor</h3><span className="muted">{image.label} · {image.width}×{image.height} (native resolution)</span>
      </div>
      <div className="row">
        <select value={kind} onChange={(e) => setKind(e.target.value as any)} data-testid="mask-kind">
          <option value="edit">Edit region (AI may change)</option>
          <option value="protected">Protected region (must not change)</option>
        </select>
        {(["rect", "brush", "erase"] as Tool[]).map((t) => <button key={t} className={tool === t ? "primary small" : "small"} onClick={() => setTool(t)}>{t === "rect" ? "Rectangle" : t === "brush" ? "Brush" : "Eraser"}</button>)}
        {tool !== "rect" && <label className="row muted">size <input type="range" min={2} max={Math.round(image.width / 8)} value={size} onChange={(e) => setSize(+e.target.value)} /></label>}
        <button className="small" onClick={clear}>Clear</button>
        <input placeholder="label, e.g. cabinet faces" value={label} onChange={(e) => setLabel(e.target.value)} />
        <div className="spacer" />
        <button className="primary" disabled={saving} onClick={save} data-testid="save-mask">Save mask</button>
        <button onClick={onDone}>Close</button>
      </div>
      <div style={{ position: "relative", background: "#000", lineHeight: 0 }}>
        <Img src={fileUrl(`/api/projects/${project.id}/images/${image.id}/file`)} style={{ width: "100%", display: "block" }} />
        <canvas ref={cv} data-testid="mask-canvas" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.5, cursor: "crosshair", touchAction: "none" }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} />
      </div>
      <div className="dim">Green = editable region · Red = protected region. Pixels outside the approved edit region are restored from the original by compositing.</div>
    </div>
  );
}
