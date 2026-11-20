// Pixel engine (browser port of backend/app/imaging.py + validation.py). Every number is measured.
export interface Px { w: number; h: number; data: Uint8ClampedArray } // RGBA
export type Mask = Uint8Array; // 1 = in region

export async function blobToPx(blob: Blob): Promise<Px> {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d")!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const d = g.getImageData(0, 0, c.width, c.height);
  return { w: d.width, h: d.height, data: d.data };
}

export async function pxToPng(px: Px): Promise<Blob> {
  const c = new OffscreenCanvas(px.w, px.h);
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(px.data), px.w, px.h), 0, 0);
  return c.convertToBlob({ type: "image/png" });
}

export async function resizeTo(blob: Blob, w: number, h: number): Promise<Px> {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d")!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const d = g.getImageData(0, 0, w, h);
  return { w, h, data: d.data };
}

export async function blobToMask(blob: Blob, w: number, h: number): Promise<Mask> {
  const px = await blobToPx(blob);
  if (px.w !== w || px.h !== h) throw new Error(`mask size ${px.w}×${px.h} does not match image size ${w}×${h}`);
  const m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) {
    const a = px.data[i * 4 + 3], l = (px.data[i * 4] + px.data[i * 4 + 1] + px.data[i * 4 + 2]) / 3;
    m[i] = a > 127 && l > 127 ? 1 : 0;
  }
  return m;
}

export function maskCoverage(m: Mask) { let n = 0; for (const v of m) n += v; return n / m.length; }

export function effectiveRegion(w: number, h: number, edit: Mask | null, prot: Mask | null, scope: string): Mask {
  const r = new Uint8Array(w * h);
  if (scope === "global") r.fill(1);
  else {
    if (!edit) throw new Error("local edits require an explicit edit mask");
    r.set(edit);
  }
  if (prot) for (let i = 0; i < r.length; i++) if (prot[i]) r[i] = 0;
  return r;
}

/** Box-blur approximation of a Gaussian, used for inward-only feathering. */
function blur(a: Float32Array, w: number, h: number, rad: number): Float32Array {
  const r = Math.max(1, Math.round(rad));
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    let s = 0; const row = y * w;
    for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / (2 * r + 1);
      s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (2 * r + 1);
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Keep original pixels outside `region` bit-exactly; feather only inside it. */
export function composite(src: Px, gen: Px, region: Mask, feather = 1.5): Px {
  if (src.w !== gen.w || src.h !== gen.h) throw new Error("generated image must match the source size before compositing");
  const n = src.w * src.h;
  let alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = region[i];
  if (feather > 0) {
    const b = blur(alpha, src.w, src.h, feather);
    for (let i = 0; i < n; i++) alpha[i] = region[i] ? Math.min(b[i] * 2, 1) : 0;
  }
  const out = new Uint8ClampedArray(src.data);
  for (let i = 0; i < n; i++) {
    if (!region[i]) continue;
    const a = alpha[i], o = i * 4;
    out[o] = Math.round(src.data[o] * (1 - a) + gen.data[o] * a);
    out[o + 1] = Math.round(src.data[o + 1] * (1 - a) + gen.data[o + 1] * a);
    out[o + 2] = Math.round(src.data[o + 2] * (1 - a) + gen.data[o + 2] * a);
    out[o + 3] = 255;
  }
  return { w: src.w, h: src.h, data: out };
}

export function changeStats(src: Px, out: Px, region: Mask, tol: number) {
  const n = src.w * src.h;
  let nOut = 0, nIn = 0, chOut = 0, chIn = 0, maxOut = 0, sumIn = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(src.data[o] - out.data[o]), Math.abs(src.data[o + 1] - out.data[o + 1]), Math.abs(src.data[o + 2] - out.data[o + 2]));
    if (region[i]) { nIn++; sumIn += d; if (d > tol) chIn++; }
    else { nOut++; if (d > tol) chOut++; if (d > maxOut) maxOut = d; }
  }
  return {
    pixels_total: n, pixels_outside: nOut, pixels_inside: nIn, changed_outside: chOut,
    changed_outside_pct: nOut ? Math.round((1e6 * chOut) / nOut) / 1e4 : 0, max_diff_outside: maxOut,
    changed_inside: chIn, changed_inside_pct: nIn ? Math.round((1e5 * chIn) / nIn) / 1e3 : 0,
    mean_diff_inside: nIn ? Math.round((1000 * sumIn) / nIn) / 1000 : 0, tolerance: tol,
  };
}

export function diffPx(src: Px, out: Px, gain = 4): Px {
  const n = src.w * src.h, d = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const v = Math.min(255, gain * Math.max(Math.abs(src.data[o] - out.data[o]), Math.abs(src.data[o + 1] - out.data[o + 1]), Math.abs(src.data[o + 2] - out.data[o + 2])));
    const base = ((src.data[o] + src.data[o + 1] + src.data[o + 2]) / 3) * 0.25;
    d[o] = Math.max(base, v); d[o + 1] = Math.max(base, v * 0.35); d[o + 2] = base; d[o + 3] = 255;
  }
  return { w: src.w, h: src.h, data: d };
}

export function overlayPx(src: Px, region: Mask, prot: Mask | null): Px {
  const d = new Uint8ClampedArray(src.data);
  for (let i = 0; i < region.length; i++) {
    const o = i * 4;
    const c = prot && prot[i] ? [230, 60, 60] : region[i] ? [40, 200, 120] : null;
    if (!c) continue;
    d[o] = d[o] * 0.55 + c[0] * 0.45; d[o + 1] = d[o + 1] * 0.55 + c[1] * 0.45; d[o + 2] = d[o + 2] * 0.55 + c[2] * 0.45;
  }
  return { w: src.w, h: src.h, data: d };
}

export async function sha256(blob: Blob): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- validation (NODE 08)
export function runChecks(src: Px, final: Px, region: Mask, prot: Mask | null, composited: boolean, sourceHashOk: boolean, alignNote: string) {
  const checks: any[] = [];
  const dimsOk = src.w === final.w && src.h === final.h;
  checks.push({ id: "dimensions", label: "Output dimensions equal source dimensions", passed: dimsOk,
    detail: `source ${src.w}×${src.h}, output ${final.w}×${final.h}. ${alignNote}`, blocking: true });
  checks.push({ id: "source_integrity", label: "Source image file unchanged (SHA-256 verified)", passed: sourceHashOk,
    detail: sourceHashOk ? "hash matches original upload" : "HASH MISMATCH", blocking: true });
  let stats: any = {};
  if (dimsOk) {
    const tol = composited ? 0 : 6;
    stats = changeStats(src, final, region, tol);
    const ok = composited ? stats.changed_outside === 0 : stats.changed_outside_pct < 0.5;
    checks.push({ id: "outside_region", label: "No changes outside the authorised edit region", passed: ok,
      detail: composited
        ? ok ? `VERIFIED pixel-identical outside the edit region: 0 of ${stats.pixels_outside.toLocaleString()} pixels changed`
          : `${stats.changed_outside.toLocaleString()} of ${stats.pixels_outside.toLocaleString()} pixels changed outside the region`
        : `Not composited: ${stats.changed_outside_pct}% of pixels outside the region differ by more than ${tol} levels (max Δ ${stats.max_diff_outside}). Outside pixels are NOT guaranteed identical.`,
      blocking: true });
    if (prot && prot.some((v) => v)) {
      const inv = new Uint8Array(prot.length);
      for (let i = 0; i < inv.length; i++) inv[i] = prot[i] ? 0 : 1;
      const ps = changeStats(src, final, inv, tol);
      const pok = composited ? ps.changed_outside === 0 : ps.changed_outside_pct < 0.05;
      checks.push({ id: "protected", label: "Protected regions unchanged", passed: pok,
        detail: `${ps.changed_outside.toLocaleString()} of ${ps.pixels_outside.toLocaleString()} protected pixels changed`, blocking: true });
    }
    checks.push({ id: "edit_visible", label: "A change is present inside the edit region", passed: stats.mean_diff_inside >= 1,
      detail: `mean Δ inside region ${stats.mean_diff_inside.toFixed(2)}; ${stats.changed_inside_pct.toFixed(1)}% of region pixels changed`, blocking: false });
  }
  return { checks, stats, composited, automated_passed: checks.filter((c) => c.blocking).every((c) => c.passed) };
}

export const STANDARD_ITEMS: [string, string][] = [
  ["geometry", "Geometry, camera and perspective unchanged"],
  ["equipment", "Equipment unchanged (no added, moved or removed items)"],
  ["adjacent", "Adjacent finishes outside the edit unchanged"],
  ["no_additions", "No unrequested objects added"],
  ["shadows", "Shadows were not interpreted as material changes"],
];
export function buildChecklist(analysis: any) {
  const items: any[] = [];
  for (const ref of analysis?.referenced_finishes || []) {
    if (ref.status === "approved") {
      const d = ref.data || {};
      items.push({ id: `finish_${ref.code}`, label: `Edited surface matches ${ref.code} — ${`${d.manufacturer || ""} ${d.product || ""}`.trim()}`, checked: false, required: true });
    }
  }
  for (const [id, label] of STANDARD_ITEMS) items.push({ id, label, checked: false, required: true });
  return { items };
}
export const checklistComplete = (cl: any) => (cl?.items || []).filter((i: any) => i.required).every((i: any) => i.checked);
