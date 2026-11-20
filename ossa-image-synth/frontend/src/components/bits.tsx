import { useCallback, useEffect, useState } from "react";
import { errText } from "../api";
import { useP } from "../ctx";
import { STATE_LABEL, type ModuleState, type Requirement } from "../types";

export function StateDot({ state }: { state: ModuleState }) {
  return <span className={`dot st s-${state}`} title={STATE_LABEL[state]} />;
}
export function StateBadge({ state }: { state: ModuleState }) {
  return <span className={`badge s-${state}`}>{STATE_LABEL[state]}</span>;
}

export function Requirements({ reqs }: { reqs: Requirement[] }) {
  return (
    <div className="col" style={{ gap: 3 }}>
      {reqs.map((r) => (
        <div key={r.id} className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
          <span style={{ width: 16, color: r.satisfied ? "var(--ok)" : r.required ? "var(--err)" : "var(--dim)" }}>
            {r.satisfied ? "✓" : r.required ? "✕" : "○"}
          </span>
          <div>
            <div>{r.label} {!r.required && <span className="dim">(recommended)</span>}</div>
            {r.detail && <div className="dim" style={{ fontSize: 11 }}>{r.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Load data from the API; reloads when deps or the global refresh tick change. */
export function useLoad<T>(fn: () => Promise<T>, deps: any[] = []) {
  const { tick, toast } = useP();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      setData(await fn());
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setLoading(false);
    }
  }, deps); // eslint-disable-line
  useEffect(() => { reload(); }, [reload, tick]);
  return { data, reload, loading, setData };
}

export function useAction() {
  const { toast, refresh } = useP();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<any>, ok?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast(ok, "ok");
      await refresh();
      return r;
    } catch (e) {
      toast(errText(e), "err");
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast, refresh]);
  return { busy, run };
}

export function OriginPill({ origin }: { origin: string }) {
  const cls = origin === "ai" ? "pill ai" : origin === "reference" ? "pill warn" : origin === "user" ? "pill ok" : "pill";
  const label = origin === "ai" ? "AI assumption" : origin === "reference" ? "reference" : origin === "user" ? "user entry" : "extracted";
  return <span className={cls}>{label}</span>;
}

export function StatusPill({ status }: { status: string }) {
  const cls = status === "approved" || status === "accepted" || status === "authorized" ? "pill ok"
    : status === "rejected" ? "pill err" : "pill warn";
  return <span className={cls}>{status}</span>;
}
