import { useP } from "../ctx";
import type { ModuleKey } from "../types";
import { Requirements, StateBadge } from "./bits";
import IntakePanel from "../panels/IntakePanel";
import RecordsPanel from "../panels/RecordsPanel";
import SourcePanel from "../panels/SourcePanel";
import IntentPanel from "../panels/IntentPanel";
import OscillatorPanel from "../panels/OscillatorPanel";
import OutputPanel from "../panels/OutputPanel";
import QAPanel from "../panels/QAPanel";

export default function Inspector({ k, wide, setWide, onClose }: { k: ModuleKey; wide: boolean; setWide: (w: boolean) => void; onClose: () => void }) {
  const { modules } = useP();
  const info = modules?.[k];
  return (
    <div className={"inspector" + (wide ? " wide" : "")} data-testid={`inspector-${k}`}>
      <div className="ihd">
        <span className="mono" style={{ color: "var(--brand)" }}>NODE {k.slice(1)}</span>
        <h3>{info?.name}</h3>
        {info && <StateBadge state={info.state} />}
        <div className="spacer" />
        <button className="small" onClick={() => setWide(!wide)}>{wide ? "Dock" : "Expand"}</button>
        <button className="small" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="ibd">
        {info && (
          <details className="card" open={info.state !== "VALIDATED"} style={{ marginBottom: 12 }}>
            <summary style={{ cursor: "pointer" }}>
              <b>Requirements</b> <span className="muted">· inputs: {info.inputs}</span>
              {info.missing.length > 0 && <span className="pill err" style={{ marginLeft: 8 }}>{info.missing.length} missing</span>}
            </summary>
            <div style={{ marginTop: 8 }}><Requirements reqs={info.requirements} /></div>
            {info.sources?.length > 0 && (
              <div style={{ marginTop: 8 }} className="muted">Sources: {info.sources.map((s) => `${s.name} (${s.mapping})`).join(", ")}</div>
            )}
          </details>
        )}
        {k === "N09" && <IntakePanel />}
        {(k === "N01" || k === "N02" || k === "N03") && <RecordsPanel module={k} />}
        {k === "N05" && <SourcePanel />}
        {k === "N04" && <IntentPanel />}
        {k === "N07" && <OscillatorPanel />}
        {k === "N08" && <OutputPanel />}
        {k === "N06" && <QAPanel />}
      </div>
    </div>
  );
}
