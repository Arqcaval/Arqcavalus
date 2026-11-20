export class ApiError extends Error {
  status: number;
  detail: any;
  constructor(status: number, detail: any) {
    super(typeof detail === "string" ? detail : detail?.message || JSON.stringify(detail));
    this.status = status;
    this.detail = detail;
  }
}

let token: string | null = null;
try {
  token = localStorage.getItem("is_token");
} catch {
  token = null;
}
let onUnauthorized: () => void = () => {};

export const auth = {
  get token() {
    return token;
  },
  set(t: string | null) {
    token = t;
    try {
      if (t) localStorage.setItem("is_token", t);
      else localStorage.removeItem("is_token");
    } catch {
      /* storage unavailable */
    }
  },
  onUnauthorized(fn: () => void) {
    onUnauthorized = fn;
  },
};

async function request<T = any>(method: string, url: string, body?: any): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const r = await fetch(url, { method, headers, body: payload });
  if (r.status === 401 && !url.endsWith("/auth/login")) {
    auth.set(null);
    onUnauthorized();
  }
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new ApiError(r.status, (data as any)?.detail ?? data);
  return data as T;
}

export const api = {
  get: <T = any>(u: string) => request<T>("GET", u),
  post: <T = any>(u: string, b?: any) => request<T>("POST", u, b ?? {}),
  put: <T = any>(u: string, b?: any) => request<T>("PUT", u, b),
  patch: <T = any>(u: string, b?: any) => request<T>("PATCH", u, b),
  del: <T = any>(u: string) => request<T>("DELETE", u),
};

/** URL for <img>/<a> elements; the session token travels as a query parameter. */
export function fileUrl(path: string, params: Record<string, string | boolean | undefined> = {}) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== undefined && q.set(k, String(v)));
  if (token) q.set("token", token);
  return `${path}?${q.toString()}`;
}

export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) return d.map((x: any) => x.msg || JSON.stringify(x)).join("; ");
    if (d?.message) return d.message + (d.failed ? `: ${d.failed.join("; ")}` : "");
    return JSON.stringify(d);
  }
  return String((e as any)?.message || e);
}
