import { useRef, useState } from "react";
import { Img } from "../components/bits";

export type CompareMode = "slider" | "side" | "overlay" | "diff" | "mask" | "raw";

export default function CompareViewer({ original, output, diff, mask, raw }: { original: string; output: string; diff: string; mask: string; raw: string }) {
  const [mode, setMode] = useState<CompareMode>("slider");
  const [pos, setPos] = useState(50);
  const [opacity, setOpacity] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const setFromEvent = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    setPos(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
  };
  const modes: [CompareMode, string][] = [["slider", "Before / after"], ["side", "Side by side"], ["overlay", "Overlay"], ["diff", "Difference"], ["mask", "Edit mask"], ["raw", "As returned by ChatGPT"]];
  return (
    <div>
      <div className="tabs">{modes.map(([m, l]) => <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)} data-testid={`view-${m}`}>{l}</button>)}</div>
      {mode === "slider" && (
        <div className="viewer" ref={box} data-testid="slider" style={{ cursor: "ew-resize" }}
          onPointerDown={(e) => { dragging.current = true; (e.target as Element).setPointerCapture(e.pointerId); setFromEvent(e); }}
          onPointerMove={(e) => dragging.current && setFromEvent(e)} onPointerUp={() => (dragging.current = false)}>
          <Img src={original} />
          <Img className="top" src={output} style={{ clipPath: `inset(0 0 0 ${pos}%)` }} />
          <div className="handle" style={{ left: `${pos}%` }} />
          <span className="lbl" style={{ left: 6 }}>ORIGINAL</span><span className="lbl" style={{ right: 6 }}>OUTPUT</span>
        </div>
      )}
      {mode === "side" && (
        <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
          <div className="viewer" style={{ flex: 1 }}><Img src={original} /><span className="lbl" style={{ left: 6 }}>ORIGINAL</span></div>
          <div className="viewer" style={{ flex: 1 }}><Img src={output} /><span className="lbl" style={{ left: 6 }}>OUTPUT</span></div>
        </div>
      )}
      {mode === "overlay" && (
        <>
          <div className="viewer"><Img src={original} /><Img className="top" src={output} style={{ opacity: opacity / 100 }} /></div>
          <label className="row muted">Output opacity <input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(+e.target.value)} /> {opacity}%</label>
        </>
      )}
      {mode === "diff" && <><div className="viewer"><Img src={diff} /></div><div className="dim">Measured per-pixel difference (amplified ×4). Black = identical.</div></>}
      {mode === "mask" && <><div className="viewer"><Img src={mask} /></div><div className="dim">Green = authorised edit region · Red = protected region.</div></>}
      {mode === "raw" && <><div className="viewer"><Img src={raw} /></div><div className="dim">The image exactly as ChatGPT returned it, before Image Synth restored the framing and the untouched pixels. Not used for approval.</div></>}
    </div>
  );
}
