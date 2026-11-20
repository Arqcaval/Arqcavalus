// Same interface the server edition used; requests are answered locally by the store.
import { fileKey, route, store } from "./store";

export class ApiError extends Error {
  status: number;
  detail: any;
  constructor(status: number, detail: any) {
    super(typeof detail === "string" ? detail : detail?.message || JSON.stringify(detail));
    this.status = status;
    this.detail = detail;
  }
}

async function request<T = any>(method: string, url: string, body?: any): Promise<T> {
  if (method !== "GET" && !store.canWrite) throw new ApiError(403, "You can view this page but not change it. Ask the owner for Contributor or Editor access.");
  try {
    return (await route(method, url, body)) as T;
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    const msg = e?.code && e?.message ? `${e.message} (${e.code})` : String(e?.message || e);
    throw new ApiError(400, msg);
  }
}

export const api = {
  get: <T = any>(u: string) => request<T>("GET", u),
  post: <T = any>(u: string, b?: any) => request<T>("POST", u, b ?? {}),
  put: <T = any>(u: string, b?: any) => request<T>("PUT", u, b),
  patch: <T = any>(u: string, b?: any) => request<T>("PATCH", u, b),
  del: <T = any>(u: string) => request<T>("DELETE", u),
};

/** A key identifying a stored or derived image; render it with <Img src={...}>. */
export function fileUrl(path: string, params: Record<string, string | boolean | undefined> = {}) {
  return fileKey(path, params);
}

export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.detail;
    if (typeof d === "string") return d;
    if (d?.message) return d.message + (d.failed ? `: ${d.failed.join("; ")}` : "");
    return JSON.stringify(d);
  }
  return String((e as any)?.message || e);
}
