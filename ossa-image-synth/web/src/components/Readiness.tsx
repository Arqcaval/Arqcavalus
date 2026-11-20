import { useP } from "../ctx";
import type { ModuleKey } from "../types";
import { StateDot } from "./bits";

const ORDER: ModuleKey[] = ["N09", "N01", "N02", "N03", "N05", "N04", "N07", "N08", "N06"];

export default function Readiness() {
  const { modules, open } = useP();
  if (!modules) return <div className="readiness muted">Evaluating modules…</div>;
  const sat = ORDER.filter((k) => modules[k].readiness === "satisfied").length;
  const blocked = ORDER.filter((k) => modules[k].readiness === "blocked");
  const exec = (["N01", "N04", "N05"] as ModuleKey[]).every((k) => modules[k].state === "VALIDATED");
  return (
    <div className="readiness" data-testid="readiness">
      <b style={{ marginRight: 4 }}>Readiness</b>
      <span className="muted" style={{ marginRight: 8 }}>{sat}/9 satisfied · {blocked.length} blocked</span>
      {ORDER.map((k) => (
        <span key={k} className={`chip s-${modules[k].state}`} onClick={() => open(k)} title={modules[k].missing.join("\n") || "All requirements satisfied"}>
          <StateDot state={modules[k].state} />
          <span className="mono dim">{k.slice(1)}</span>
          {modules[k].name.split(" ")[0]}
        </span>
      ))}
      <div className="spacer" />
      <span className={exec ? "pill ok" : "pill err"} title="N01, N04 and N05 must be VALIDATED (plus N02/N03 when the edit needs them)">
        {exec ? "Ready to edit" : "Not ready to edit yet"}
      </span>
    </div>
  );
}
