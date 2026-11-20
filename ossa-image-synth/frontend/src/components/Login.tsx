import { useState } from "react";
import { api, auth, errText } from "../api";
import type { User } from "../types";

export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      const r = await api.post("/api/auth/login", { email, password });
      auth.set(r.token);
      onLogin(r.user);
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <div className="login">
      <form className="card col" onSubmit={submit} style={{ gap: 12 }}>
        <div className="brand" style={{ flexDirection: "column", gap: 2 }}>
          <b>OSSA STUDIO</b>
          <span>IMAGE SYNTH</span>
        </div>
        <div className="muted">Document-grounded architectural visualization</div>
        <label className="col" style={{ gap: 3 }}>Email<input name="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="col" style={{ gap: 3 }}>Password<input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {err && <div className="err-box">{err}</div>}
        <button className="primary" type="submit">Sign in</button>
      </form>
    </div>
  );
}
