// Persistence (artifact db + assets) and a local request router so the UI keeps the same
// api.get/post/patch shape it had against the server edition.
import * as P from "./engine/parsers";
import * as I from "./engine/imaging";
import * as R from "./engine/rules";

declare global { interface Window { claude?: { use: (n: string) => Promise<any> } } }

export interface State {
  project: any; documents: any[]; records: any[]; images: any[]; requests: any[]; runs: any[];
  outputs: any[]; qa: any[]; audit: any[]; rules: any[]; hashFailures: Set<string>;
}

const COLS = ["documents", "records", "images", "requests", "runs", "outputs", "qa", "audit"] as const;
export const newId = () => crypto.randomUUID().replace(/-/g, "");
const now = () => new Date().toISOString();

class Store {
  db: any = null; assets: any = null; user: any = null; sample: any = null; downloads: any = null;
  ready = false; failed = ""; canWrite = true; canUpload = false; me = "";
  projects: any[] = [];
  pid: string | null = null;
  s: State = { project: null, documents: [], records: [], images: [], requests: [], runs: [], outputs: [], qa: [], audit: [], rules: [], hashFailures: new Set() };
  loaded = new Set<string>();
  private subs: (() => void)[] = [];
  private listeners = new Set<() => void>();
  private blobCache = new Map<string, Promise<Blob>>();
  private urlCache = new Map<string, Promise<string>>();

  on(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { this.listeners.forEach((f) => f()); }

  async init() {
    const c = window.claude;
    if (!c?.use) { this.failed = "Open this page on claude.ai to use it."; this.emit(); return; }
    const [db, assets, user, sample, downloads] = await Promise.all(["db", "assets", "user", "sample", "downloads"].map((n) => c.use(n).catch(() => null)));
    Object.assign(this, { db, assets, user, sample, downloads });
    if (!db) { this.failed = "Sign in to claude.ai to open Image Synth. Your projects are stored with this page."; this.emit(); return; }
    this.canUpload = !!assets;
    try {
      const w = await user?.can?.("data.write");
      this.canWrite = w !== false;
      this.me = (await user?.me?.())?.name || "";
    } catch { /* keep defaults */ }
    const timer = setTimeout(() => { if (!this.ready) { this.failed = "The project store is not answering yet. Check your connection; the page keeps trying."; this.emit(); } }, 10000);
    db.collection("projects").onSnapshot((snap: any) => {
      this.projects = snap.docs.map((d: any) => ({ id: d.id, ...d.data() })).sort((a: any, b: any) => (a.created_at > b.created_at ? 1 : -1));
      if (!snap.metadata.fromCache) { this.ready = true; clearTimeout(timer); if (this.failed.startsWith("The project store")) this.failed = ""; }
      if (this.pid) this.s.project = this.projects.find((p) => p.id === this.pid) || null;
      this.emit();
    }, (e: any) => { this.failed = `The project store stopped answering (${e.code}). Reload the page.`; this.emit(); });
    db.collection("rules").onSnapshot((snap: any) => { this.s.rules = snap.docs.map((d: any) => ({ id: d.id, ...d.data() })); this.emit(); }, () => {});
  }

  select(pid: string | null) {
    if (pid === this.pid) return;
    this.subs.forEach((u) => u());
    this.subs = [];
    this.pid = pid;
    this.loaded.clear();
    this.s = { ...this.s, project: this.projects.find((p) => p.id === pid) || null, documents: [], records: [], images: [], requests: [], runs: [], outputs: [], qa: [], audit: [], hashFailures: new Set() };
    if (!pid || !this.db) { this.emit(); return; }
    for (const col of COLS) {
      this.subs.push(this.db.collection(`projects/${pid}/${col}`).onSnapshot((snap: any) => {
        (this.s as any)[col] = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
        this.loaded.add(col);
        this.emit();
      }, () => {}));
    }
    this.emit();
  }

  // ---- low-level helpers
  col(c: string) { return this.db.collection(`projects/${this.pid}/${c}`); }
  async put(c: string, id: string, data: any) { await this.col(c).doc(id).set(JSON.parse(JSON.stringify(data))); }
  async patch(c: string, id: string, data: any) { await this.col(c).doc(id).update(JSON.parse(JSON.stringify(data))); }
  async audit(action: string, target = "", detail: any = {}) {
    try { await this.put("audit", newId(), { action, target, detail, user: this.me, created_at: now() }); } catch { /* audit is best effort */ }
  }
  async qa(category: string, title: string, detail = "", related: any = {}, is_lesson = false) {
    await this.put("qa", newId(), { category, title, detail, related, is_lesson, active: true, scope: "project", created_at: now(), created_by: this.me });
  }
  async upload(blob: Blob, type: string): Promise<string> {
    if (!this.assets) throw new Error("Only people with edit access to this page can upload files. Ask the owner to share it with you as an Editor.");
    const r = await this.assets.upload(blob, { type });
    return r.id;
  }
  blob(assetId: string): Promise<Blob> {
    if (!this.blobCache.has(assetId)) this.blobCache.set(assetId, fetch("/_blob/" + assetId).then((r) => { if (!r.ok) throw new Error(`file ${assetId} could not be loaded (${r.status})`); return r.blob(); }));
    return this.blobCache.get(assetId)!;
  }
  /** A display URL for a derived image, computed once and cached. */
  derived(key: string, make: () => Promise<Blob>): Promise<string> {
    if (!this.urlCache.has(key)) this.urlCache.set(key, make().then((b) => URL.createObjectURL(b)));
    return this.urlCache.get(key)!;
  }
}
export const store = new Store();

// ------------------------------------------------------------------ document processing
const MIME: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  csv: "text/csv", txt: "text/plain", text: "text/plain", spec: "text/plain", md: "text/markdown" };

async function storeOriginal(file: Blob, ext: string): Promise<{ asset_id: string | null; note: string }> {
  if (MIME[ext]) return { asset_id: await store.upload(file, MIME[ext]), note: "" };
  return { asset_id: null, note: ext === "xlsx" ? "The original workbook is not kept here (this storage accepts no .xlsx files); its extracted rows are." : "The original file is not kept here; only its identification is." };
}

async function originalBlob(d: any): Promise<Blob | null> { return d.asset_id ? store.blob(d.asset_id) : null; }

export async function processDocument(d: any, file?: Blob) {
  await store.patch("documents", d.id, { status: "processing" });
  try {
    const blob = file || (await originalBlob(d));
    if (!blob) throw new Error("The original file is not available to re-read.");
    const ex = await P.extract(d.ext, blob);
    const upd: any = { page_count: ex.pageCount, text_excerpt: P.fullText(ex).slice(0, 20000), warnings: ex.warnings, tables: ex.tables.length };
    if (d.classification_source !== "manual") {
      const [t, conf, ev] = P.classify(d.original_name, ex);
      Object.assign(upd, { doc_type: t, classification_confidence: conf, classification_evidence: ev });
    } else upd.doc_type = d.doc_type;
    // Remove unreviewed proposals from this document; reviewed records stay (they are human decisions).
    for (const r of store.s.records.filter((x) => x.document_id === d.id && x.status === "proposed")) await store.col("records").doc(r.id).delete();
    const keep = (d.mappings || []).filter((m: any) => m.status !== "proposed" && (P.TYPE_MODULES[upd.doc_type] || []).includes(m.module_key));
    if (ex.unsupported) {
      await store.patch("documents", d.id, { ...upd, status: "unsupported", error: ex.unsupported, mappings: [] });
      await store.audit("document.unsupported", d.id, { reason: ex.unsupported });
      return;
    }
    const modules = P.TYPE_MODULES[upd.doc_type] || [];
    const mappings = [...keep];
    for (const mk of modules) if (!mappings.some((m) => m.module_key === mk))
      mappings.push({ id: newId(), module_key: mk, status: "proposed", confidence: upd.classification_confidence ?? 1,
        evidence: [`document classified as ${upd.doc_type}`] });
    let props: P.Proposed[] = [];
    if (ex.kind !== "image") {
      if (modules.includes("N02")) props = props.concat(P.parseFinishes(ex));
      if (modules.includes("N03") && ["equipment_schedule", "cut_sheet"].includes(upd.doc_type)) props = props.concat(P.parseEquipment(ex));
      if (upd.doc_type === "equipment_plan") props = props.concat(P.findEquipmentOnPlan(ex, store.s.records.filter((r) => r.record_type === "equipment" && r.status !== "rejected").map((r) => r.key)));
      if (modules.includes("N01")) props = props.concat(P.parseProject(ex, d.original_name));
    }
    let n = 0;
    for (const p of props) {
      if (store.s.records.some((r) => r.document_id === d.id && r.record_type === p.record_type && r.key === p.key && r.status !== "proposed")) continue;
      await store.put("records", newId(), { ...p, notes: p.notes.join("; "), status: "proposed", origin: "parser", document_id: d.id, created_at: now() });
      n++;
    }
    if (P.IMAGE_EXT.includes(d.ext) && upd.doc_type === "source_image" && !store.s.images.some((i) => i.document_id === d.id))
      await store.put("images", newId(), { document_id: d.id, label: d.original_name, width: ex.image!.width, height: ex.image!.height,
        sha256: d.sha256, asset_id: d.asset_id, ext: d.ext, status: "candidate", masks: [], created_at: now() });
    await store.patch("documents", d.id, { ...upd, status: "processed", error: "", mappings,
      note: modules.length ? "" : "No module can use this document as classified. Change the classification if it is wrong." });
    await store.audit("document.processed", d.id, { doc_type: upd.doc_type, modules, records_proposed: n });
  } catch (e: any) {
    await store.patch("documents", d.id, { status: "error", error: String(e?.message || e) });
    await store.audit("document.error", d.id, { error: String(e?.message || e) });
  }
}

async function uploadFiles(files: File[]) {
  const results: any[] = [];
  for (const f of files) {
    const name = f.name;
    let ext = (name.includes(".") ? name.split(".").pop()! : "").toLowerCase();
    if (ext === "jpeg") ext = "jpg";
    if (![...P.SUPPORTED_EXT, ...P.CAD_EXT].includes(ext)) { results.push({ name, error: `Unsupported file type .${ext}. Use PDF, PNG, JPEG, WEBP, CSV, XLSX or TXT/MD.` }); continue; }
    if (f.size > 20 * 1024 * 1024) { results.push({ name, error: "File is larger than 20 MB" }); continue; }
    if (!f.size) { results.push({ name, error: "Empty file" }); continue; }
    try {
      const sha = await I.sha256(f);
      const dup = store.s.documents.find((x) => x.sha256 === sha);
      const { asset_id, note } = await storeOriginal(f, ext);
      const d: any = { id: newId(), original_name: name, ext, size: f.size, sha256: sha, asset_id, storage_note: note, doc_type: "unknown",
        classification_confidence: 0, classification_evidence: [], classification_source: "auto", status: "uploaded", error: "",
        mappings: [], duplicate_of: dup?.id || null, created_at: now(), uploaded_by: store.me };
      await store.put("documents", d.id, d);
      await store.audit("document.upload", d.id, { name, sha256: sha, size: f.size });
      await processDocument(d, f);
      results.push(d);
    } catch (e: any) { results.push({ name, error: String(e?.message || e) }); }
  }
  return results;
}

// ------------------------------------------------------------------ Claude-assisted reading
const AI_EXTRACT = `You read architectural project documents for OSSA Studio. Extract ONLY what the document states; never guess.
Return JSON: {"finishes":[{"code","manufacturer","product","category","color_name","texture","application","where_found"}],
"equipment":[{"tag","description","manufacturer","model","dimensions","schedule_location","where_found"}],
"project":{"project_name","client","address","rooms":[{"number","name","where_found"}],"sheets":[{"sheet","title"}]}}.
category is one of paint, laminate, solid_surface, tile, wood_paneling, acoustic_ceiling, stone, quartz, metal, glass, carpet, other.
Use empty arrays/strings when absent. where_found = page or row reference.`;

async function pdfPageImages(blob: Blob, max = 3): Promise<Blob[]> {
  const lib = (window as any).pdfjsLib;
  const pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
  const out: Blob[] = [];
  for (let i = 1; i <= Math.min(max, pdf.numPages); i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 1568 / Math.max(vp.width, vp.height));
    const v2 = page.getViewport({ scale });
    const c = document.createElement("canvas");
    c.width = Math.round(v2.width); c.height = Math.round(v2.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: v2 }).promise;
    out.push(await new Promise<Blob>((res) => c.toBlob((b) => res(b!), "image/jpeg", 0.85)));
  }
  return out;
}
async function shrinkImage(blob: Blob, max = 1568): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.convertToBlob({ type: "image/jpeg", quality: 0.85 });
}

async function aiRead(d: any) {
  if (!store.sample) throw new Error("Claude reading is not available in this view.");
  const blob = await originalBlob(d);
  let images: Blob[] = [];
  let text = d.text_excerpt || "";
  if (!text.trim() && blob) images = d.ext === "pdf" ? await pdfPageImages(blob) : P.IMAGE_EXT.includes(d.ext) ? [await shrinkImage(blob)] : [];
  if (!text.trim() && !images.length) throw new Error("This document has no readable content.");
  const input = `${AI_EXTRACT}\n\nDocument: ${d.original_name}\n${text ? "Text:\n" + text.slice(0, 60000) : "(see attached page images)"}`;
  const res: any = await store.sample.json(input, images.length ? { images, modelTier: "complex" } : { modelTier: "complex" });
  const base = { status: "proposed", origin: "ai", document_id: d.id, confidence: 0.4, created_at: now(), notes: "Read by Claude. Verify against the document before approving." };
  let n = 0;
  for (const f of res?.finishes || []) if (f.code) {
    const cat = f.category || P.materialCategory(f.code, `${f.manufacturer} ${f.product}`)[0];
    await store.put("records", newId(), { ...base, module_key: "N02", record_type: "finish", key: String(f.code).toUpperCase(),
      data: { ...f, category: cat }, source_ref: `${d.original_name}${f.where_found ? " · " + f.where_found : ""} (Claude)`, evidence: `${f.code} ${f.manufacturer || ""} ${f.product || ""}` }); n++;
  }
  for (const e of res?.equipment || []) if (e.tag) {
    await store.put("records", newId(), { ...base, module_key: "N03", record_type: "equipment", key: String(e.tag).toUpperCase(),
      data: { ...e, location_verified: false }, source_ref: `${d.original_name}${e.where_found ? " · " + e.where_found : ""} (Claude)`, evidence: `${e.tag} ${e.description || ""}` }); n++;
  }
  const pj = res?.project || {};
  if (pj.project_name) { await store.put("records", newId(), { ...base, module_key: "N01", record_type: "project_info", key: "project_name", data: { field: "project_name", value: pj.project_name }, source_ref: `${d.original_name} (Claude)`, evidence: pj.project_name }); n++; }
  for (const r of pj.rooms || []) if (r.name) { await store.put("records", newId(), { ...base, module_key: "N01", record_type: "room", key: `${r.number || ""} ${r.name}`.trim(), data: r, source_ref: `${d.original_name}${r.where_found ? " · " + r.where_found : ""} (Claude)`, evidence: r.name }); n++; }
  for (const sh of pj.sheets || []) if (sh.sheet) { await store.put("records", newId(), { ...base, module_key: "N01", record_type: "drawing_ref", key: sh.sheet, data: sh, source_ref: `${d.original_name} (Claude)`, evidence: `${sh.sheet} ${sh.title || ""}` }); n++; }
  await store.audit("document.ai_read", d.id, { records: n });
  return { records: n };
}

// ------------------------------------------------------------------ image helpers
async function loadRegion(er: any, img: any) {
  const m = (id: string | null) => (img.masks || []).find((x: any) => x.id === id);
  const edit = er.edit_mask_id ? await I.blobToMask(await store.blob(m(er.edit_mask_id).asset_id), img.width, img.height) : null;
  const prot = er.protected_mask_id ? await I.blobToMask(await store.blob(m(er.protected_mask_id).asset_id), img.width, img.height) : null;
  return { region: I.effectiveRegion(img.width, img.height, edit, prot, er.scope), prot };
}

/** Pad (never stretch) the source to a 3:2, 2:3 or 1:1 canvas that image editors keep. */
const SIZES: [number, number][] = [[1536, 1024], [1024, 1536], [1024, 1024]];
function prepGeometry(w: number, h: number) {
  const [pw, ph] = SIZES.reduce((best, o) => (Math.abs(Math.log(o[0] / o[1] / (w / h))) < Math.abs(Math.log(best[0] / best[1] / (w / h))) ? o : best));
  const scale = Math.min(pw / w, ph / h);
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  return { pw, ph, nw, nh, left: Math.floor((pw - nw) / 2), top: Math.floor((ph - nh) / 2) };
}
async function preparedImage(img: any): Promise<Blob> {
  const g = prepGeometry(img.width, img.height);
  const bmp = await createImageBitmap(await store.blob(img.asset_id));
  const c = new OffscreenCanvas(g.pw, g.ph);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, g.pw, g.ph);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, g.left, g.top, g.nw, g.nh);
  bmp.close();
  return c.convertToBlob({ type: "image/png" });
}
async function restoreReturned(returned: Blob, img: any): Promise<{ px: I.Px; note: string }> {
  const g = prepGeometry(img.width, img.height);
  const bmp = await createImageBitmap(returned);
  const rr = bmp.width / bmp.height, pr = g.pw / g.ph;
  if (Math.abs(Math.log(rr / pr)) > 0.03) {
    bmp.close();
    throw new Error(`The returned image is ${bmp.width}×${bmp.height}, a different shape from the prepared ${g.pw}×${g.ph} image, so its framing cannot be lined up with the original. Ask the AI to keep the same size and framing, then try again.`);
  }
  const sx = bmp.width / g.pw, sy = bmp.height / g.ph;
  const c = new OffscreenCanvas(img.width, img.height);
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, g.left * sx, g.top * sy, g.nw * sx, g.nh * sy, 0, 0, img.width, img.height);
  bmp.close();
  const d = ctx.getImageData(0, 0, img.width, img.height);
  return { px: { w: d.width, h: d.height, data: d.data }, note: `Returned ${Math.round(g.pw * sx)}×${Math.round(g.ph * sy)}, framing restored to ${img.width}×${img.height}.` };
}
function alignmentScore(src: I.Px, gen: I.Px, region: I.Mask) {
  let sum = 0, n = 0;
  for (let i = 0; i < region.length; i += 7) {
    if (region[i]) continue;
    const o = i * 4;
    sum += (Math.abs(src.data[o] - gen.data[o]) + Math.abs(src.data[o + 1] - gen.data[o + 1]) + Math.abs(src.data[o + 2] - gen.data[o + 2])) / 3;
    n++;
  }
  return n ? sum / n : 0;
}

async function importResult(run: any, file: Blob) {
  const s = store.s;
  const er = s.requests.find((r) => r.id === run.request_id), img = s.images.find((i) => i.id === run.image_id);
  if (!er || !img) throw new Error("The edit request or image for this run no longer exists.");
  const srcBlob = await store.blob(img.asset_id);
  const hashOk = (await I.sha256(srcBlob)) === img.sha256;
  if (!hashOk) { s.hashFailures.add(img.id); throw new Error("The stored source image no longer matches its original fingerprint. Run refused."); }
  const src = await I.blobToPx(srcBlob);
  const { region, prot } = await loadRegion(er, img);
  const { px: restored, note } = await restoreReturned(file, img);
  const align = alignmentScore(src, restored, region);
  const final = er.composite ? I.composite(src, restored, region) : restored;
  const report: any = I.runChecks(src, final, region, prot, !!er.composite, hashOk, note);
  report.checks.splice(1, 0, { id: "alignment", label: "Returned image lines up with the original", passed: align < 18,
    detail: `average difference outside the edit area before compositing: ${align.toFixed(1)} levels (${align < 18 ? "aligned" : "the AI shifted, cropped or redrew the scene; compositing would leave seams"})`, blocking: true });
  report.automated_passed = report.checks.filter((c: any) => c.blocking).every((c: any) => c.passed);
  const rawType = file.type === "image/jpeg" ? "image/jpeg" : file.type === "image/webp" ? "image/webp" : "image/png";
  const rawId = await store.upload(file, rawType);
  const finalId = await store.upload(await I.pxToPng(final), "image/png");
  const version = s.outputs.filter((o) => o.request_id === er.id).length + 1;
  const gid = newId();
  await store.put("outputs", gid, { request_id: er.id, run_id: run.id, image_id: img.id, version, raw_asset_id: rawId, final_asset_id: finalId,
    composited: !!er.composite, width: final.w, height: final.h, validation: report, checklist: I.buildChecklist(er.analysis), status: "pending_review",
    engine: run.engine, instruction: er.instruction, scope: er.scope, created_at: now(), decided_by: null, decision_reason: "", override_reason: "" });
  await store.patch("runs", run.id, { status: "returned", output_id: gid, returned_at: now() });
  if (!report.automated_passed) {
    const failed = report.checks.filter((c: any) => c.blocking && !c.passed);
    await store.qa(failed.some((c: any) => ["outside_region", "protected"].includes(c.id)) ? "unauthorized_edit" : "failed_generation",
      `Automated checks failed for output v${version}`, failed.map((c: any) => c.label).join("; "), { output_id: gid });
  }
  await store.audit("run.returned", run.id, { output_id: gid, passed: report.automated_passed });
  return gid;
}

// ------------------------------------------------------------------ router
type H = (m: RegExpMatchArray, body: any, q: URLSearchParams) => Promise<any> | any;
const ok = { ok: true };
const need = (x: any, what = "Item") => { if (!x) throw new Error(`${what} not found in this project`); return x; };
const mapping = (mid: string) => { for (const d of store.s.documents) for (const m of d.mappings || []) if (m.id === mid) return { d, m }; return null; };
const docOut = (d: any) => ({ ...d, record_count: store.s.records.filter((r) => r.document_id === d.id).length,
  source_image_id: store.s.images.find((i) => i.document_id === d.id)?.id || null, doc_type_label: P.DOC_TYPES[d.doc_type] || d.doc_type,
  meta: { warnings: d.warnings || [], duplicate_of: d.duplicate_of, note: d.note } });
const genOut = (g: any) => ({ ...g, checklist_complete: I.checklistComplete(g.checklist),
  approval_blocked: !g.validation?.automated_passed || !I.checklistComplete(g.checklist) });
const modulesOut = () => {
  const m = R.evaluate(store.s);
  return { modules: m, execution_ready: ["N01", "N04", "N05"].every((k) => m[k].state === "VALIDATED") };
};
const QA_CATEGORIES = ["user_correction", "failed_generation", "approved_result", "material_error", "geometry_change", "equipment_hallucination", "unauthorized_edit", "override", "lesson"];

async function patchImageMasks(img: any, fn: (masks: any[]) => any[]) { await store.patch("images", img.id, { masks: fn([...(img.masks || [])]) }); }

const routes: [string, RegExp, H][] = [
  ["GET", /^\/api\/projects$/, () => store.projects.map((p) => ({ ...p, role: store.canWrite ? "owner" : "viewer" }))],
  ["POST", /^\/api\/projects$/, async (_m, b) => {
    if (!b.name?.trim()) throw new Error("Project name is required");
    const id = newId();
    await store.db.collection("projects").doc(id).set({ name: b.name.trim(), code: b.code || "", description: b.description || "", is_reference: false, canvas: {}, created_at: now(), created_by: store.me });
    return { id };
  }],
  ["GET", /^\/api\/projects\/(\w+)$/, () => ({ ...need(store.s.project, "Project"), role: store.canWrite ? "owner" : "viewer", budget_usd: 0, spent_usd: 0 })],
  ["PATCH", /^\/api\/projects\/(\w+)$/, async (m, b) => { await store.db.collection("projects").doc(m[1]).update(b); return ok; }],
  ["PUT", /^\/api\/projects\/(\w+)\/canvas$/, async (m, b) => { await store.db.collection("projects").doc(m[1]).update({ canvas: b.canvas }); return ok; }],
  ["GET", /^\/api\/projects\/(\w+)\/modules$/, () => modulesOut()],
  ["GET", /^\/api\/projects\/meta\/doc-types$/, () => Object.entries(P.DOC_TYPES).map(([value, label]) => ({ value, label, modules: P.TYPE_MODULES[value] }))],
  ["GET", /^\/api\/projects\/\w+\/documents$/, () => [...store.s.documents].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map(docOut)],
  ["POST", /^\/api\/projects\/\w+\/documents$/, (_m, b: FormData) => uploadFiles(b.getAll("files") as File[])],
  ["GET", /^\/api\/projects\/\w+\/documents\/(\w+)$/, (m) => {
    const d = need(store.s.documents.find((x) => x.id === m[1]), "Document");
    return { ...docOut(d), records: store.s.records.filter((r) => r.document_id === d.id) };
  }],
  ["PATCH", /^\/api\/projects\/\w+\/documents\/(\w+)$/, async (m, b) => {
    const d = need(store.s.documents.find((x) => x.id === m[1]), "Document");
    if (!P.DOC_TYPES[b.doc_type]) throw new Error("Unknown document type");
    const old = d.doc_type;
    const mappings = (d.mappings || []).filter((x: any) => (P.TYPE_MODULES[b.doc_type] || []).includes(x.module_key));
    const nd = { ...d, doc_type: b.doc_type, classification_source: "manual", classification_confidence: 1, mappings,
      classification_evidence: [`manually classified${b.reason ? `: ${b.reason}` : ""}`, `previous automatic classification: ${old}`] };
    await store.patch("documents", d.id, { doc_type: nd.doc_type, classification_source: "manual", classification_confidence: 1, mappings, classification_evidence: nd.classification_evidence });
    if (b.doc_type !== "source_image") for (const i of store.s.images.filter((x) => x.document_id === d.id && x.status === "candidate")) await store.col("images").doc(i.id).delete();
    await store.qa("user_correction", `Document reclassified: ${d.original_name}`, `${old} → ${b.doc_type}. ${b.reason || ""}`, { document_id: d.id });
    await store.audit("document.reclassify", d.id, { from: old, to: b.doc_type });
    await processDocument(nd);
    return ok;
  }],
  ["POST", /^\/api\/projects\/\w+\/documents\/(\w+)\/reprocess$/, async (m) => { await processDocument(need(store.s.documents.find((x) => x.id === m[1]), "Document")); return ok; }],
  ["POST", /^\/api\/projects\/\w+\/documents\/(\w+)\/ai-read$/, (m) => aiRead(need(store.s.documents.find((x) => x.id === m[1]), "Document"))],
  ["PATCH", /^\/api\/projects\/\w+\/mappings\/(\w+)$/, async (m, b) => {
    const f = need(mapping(m[1]), "Mapping");
    const mappings = f.d.mappings.map((x: any) => (x.id === m[1] ? { ...x, status: b.status } : x));
    await store.patch("documents", f.d.id, { mappings });
    if (b.status === "rejected") for (const r of store.s.records.filter((x) => x.document_id === f.d.id && x.module_key === f.m.module_key && x.status === "proposed")) await store.col("records").doc(r.id).delete();
    await store.audit("mapping.review", m[1], { status: b.status });
    return ok;
  }],
  ["GET", /^\/api\/projects\/\w+\/records$/, (_m, _b, q) => {
    const names = new Map(store.s.documents.map((d) => [d.id, d.original_name]));
    return store.s.records.filter((r) => !q.get("module") || r.module_key === q.get("module"))
      .map((r) => ({ ...r, document_name: names.get(r.document_id) })).sort((a, b) => (a.key > b.key ? 1 : -1));
  }],
  ["POST", /^\/api\/projects\/\w+\/records$/, async (_m, b) => {
    const id = newId();
    await store.put("records", id, { module_key: b.module_key, record_type: b.record_type, key: (b.key || "").trim(), data: b.data, notes: b.notes || "",
      status: "approved", origin: "user", source_ref: `entered manually${store.me ? " by " + store.me : ""}`, evidence: "manual entry", confidence: 1, document_id: null, created_at: now() });
    await store.audit("record.create", id, { key: b.key });
    return { id };
  }],
  ["PATCH", /^\/api\/projects\/\w+\/records\/(\w+)$/, async (m, b) => {
    const r = need(store.s.records.find((x) => x.id === m[1]), "Record");
    const upd: any = {};
    if (b.data) {
      upd.data = { ...r.data, ...b.data };
      if (JSON.stringify(upd.data) !== JSON.stringify(r.data))
        await store.qa(r.record_type === "finish" ? "material_error" : "user_correction", `Corrected ${r.record_type} ${r.key}`,
          `before: ${JSON.stringify(r.data)}\nafter: ${JSON.stringify(upd.data)}`, { record_id: r.id });
    }
    if (b.key != null) upd.key = String(b.key).trim();
    if (b.notes != null) upd.notes = b.notes;
    if (b.status) { upd.status = b.status; upd.reviewed_by = store.me; upd.reviewed_at = now(); }
    await store.patch("records", r.id, upd);
    if (r.record_type === "equipment_location" && b.status === "approved")
      for (const e of store.s.records.filter((x) => x.record_type === "equipment" && x.key === r.key && x.status !== "rejected"))
        await store.patch("records", e.id, { data: { ...e.data, location_verified: true, location_evidence: r.source_ref } });
    await store.audit("record.review", r.id, { status: b.status, key: r.key });
    return ok;
  }],
  ["GET", /^\/api\/projects\/\w+\/images$/, () => store.s.images],
  ["PATCH", /^\/api\/projects\/\w+\/images\/(\w+)$/, async (m, b) => {
    const img = need(store.s.images.find((x) => x.id === m[1]), "Image");
    if (b.status === "authorized") {
      const okHash = (await I.sha256(await store.blob(img.asset_id))) === img.sha256;
      if (!okHash) { store.s.hashFailures.add(img.id); throw new Error("The stored file does not match the uploaded fingerprint, so it cannot be authorised."); }
    }
    await store.patch("images", img.id, { ...b, ...(b.status === "authorized" ? { authorized_by: store.me, authorized_at: now() } : {}) });
    await store.audit("image.update", img.id, b);
    return ok;
  }],
  ["GET", /^\/api\/projects\/\w+\/images\/(\w+)\/verify$/, async (m) => {
    const img = need(store.s.images.find((x) => x.id === m[1]), "Image");
    const actual = await I.sha256(await store.blob(img.asset_id));
    if (actual !== img.sha256) store.s.hashFailures.add(img.id); else store.s.hashFailures.delete(img.id);
    return { expected: img.sha256, actual, unchanged: actual === img.sha256 };
  }],
  ["POST", /^\/api\/projects\/\w+\/images\/(\w+)\/masks$/, async (m, b: FormData) => {
    const img = need(store.s.images.find((x) => x.id === m[1]), "Image");
    const blob = b.get("file") as Blob;
    const mask = await I.blobToMask(blob, img.width, img.height);
    const cov = I.maskCoverage(mask);
    if (!cov) throw new Error("The mask is empty. Paint an area first.");
    const assetId = await store.upload(blob, "image/png");
    const rec = { id: newId(), kind: b.get("kind"), label: b.get("label") || `${b.get("kind")} mask`, asset_id: assetId, sha256: await I.sha256(blob),
      coverage: Math.round(cov * 1e5) / 1e3, status: "draft", source_image_id: img.id, created_at: now() };
    await patchImageMasks(img, (ms) => [...ms, rec]);
    await store.audit("mask.create", rec.id, { kind: rec.kind, coverage_pct: rec.coverage });
    return rec;
  }],
  ["PATCH", /^\/api\/projects\/\w+\/masks\/(\w+)$/, async (m, b) => {
    const img = need(store.s.images.find((i) => (i.masks || []).some((x: any) => x.id === m[1])), "Mask");
    await patchImageMasks(img, (ms) => ms.map((x) => (x.id === m[1] ? { ...x, ...b, approved_by: b.status === "approved" ? store.me : x.approved_by } : x)));
    await store.audit("mask.update", m[1], b);
    return ok;
  }],
  ["POST", /^\/api\/projects\/\w+\/images\/(\w+)\/analyze$/, async (m) => {
    if (!store.sample) throw new Error("Claude analysis is not available in this view.");
    const img = need(store.s.images.find((x) => x.id === m[1]), "Image");
    const r = await store.sample("You are assisting an architectural visualization QA review. List the visible surfaces and objects in this render as short bullet points (surface, apparent material, apparent colour). Mark every item as an observation, not a specification. Do not guess product names. Note any areas where shadows make the material ambiguous.",
      { images: [await shrinkImage(await store.blob(img.asset_id))] });
    const id = newId();
    await store.put("records", id, { module_key: "N05", record_type: "ai_observation", key: `analysis ${img.label}`.slice(0, 120), data: { text: r.text, image_id: img.id },
      status: "proposed", origin: "ai", source_ref: `Claude analysis of ${img.label}`, evidence: "AI assumption — not a document fact", confidence: 0.3,
      notes: "AI observations never satisfy finish or equipment requirements.", created_at: now() });
    return { data: { text: r.text } };
  }],
  ["GET", /^\/api\/projects\/\w+\/edit-requests$/, () => [...store.s.requests].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))],
  ["POST", /^\/api\/projects\/\w+\/edit-requests$/, async (_m, b) => {
    need(store.s.images.find((x) => x.id === b.source_image_id), "Image");
    const er: any = { ...b, id: newId(), status: "draft", created_at: now(), created_by: store.me };
    er.analysis = R.analyze(store.s, er);
    await store.put("requests", er.id, er);
    await store.audit("edit_request.create", er.id, { instruction: er.instruction });
    return er;
  }],
  ["PATCH", /^\/api\/projects\/\w+\/edit-requests\/(\w+)$/, async (m, b) => {
    const er = { ...need(store.s.requests.find((x) => x.id === m[1]), "Edit request") };
    const { status, ...changes } = b;
    Object.assign(er, changes);
    if (Object.keys(changes).length) er.status = "draft";
    er.analysis = R.analyze(store.s, er);
    if (status === "approved") {
      if (er.analysis.blocking) throw new Error("Cannot approve yet: " + er.analysis.issues.filter((i: any) => i.severity === "block").map((i: any) => i.message).join(" "));
      if (er.scope === "local" && R.findMask(store.s, er.edit_mask_id)?.status !== "approved") throw new Error("Approve the edit mask first (Source Images & Masks).");
      er.status = "approved"; er.approved_by = store.me;
    }
    const { id, ...rest } = er;
    await store.put("requests", id, rest);
    await store.audit("edit_request.update", id, { status: er.status });
    return er;
  }],
  ["GET", /^\/api\/projects\/\w+\/generations$/, () => [...store.s.outputs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map(genOut)],
  ["PATCH", /^\/api\/projects\/\w+\/generations\/(\w+)\/checklist$/, async (m, b) => {
    const g = need(store.s.outputs.find((x) => x.id === m[1]), "Output");
    if (g.status !== "pending_review") throw new Error("This output has already been decided");
    const items = g.checklist.items.map((i: any) => (i.id in b.items ? { ...i, checked: !!b.items[i.id], checked_by: store.me } : i));
    await store.patch("outputs", g.id, { checklist: { items } });
    return ok;
  }],
  ["POST", /^\/api\/projects\/\w+\/generations\/(\w+)\/decision$/, async (m, b) => {
    const g = need(store.s.outputs.find((x) => x.id === m[1]), "Output");
    if (g.status !== "pending_review") throw new Error(`Output already ${g.status}`);
    const out: any = {};
    const upd: any = { decided_by: store.me, decided_at: now(), decision_reason: b.reason || "" };
    if (b.decision === "approve") {
      const autoOk = g.validation?.automated_passed, clOk = I.checklistComplete(g.checklist);
      if (!(autoOk && clOk)) {
        const failed = (g.validation?.checks || []).filter((c: any) => c.blocking && !c.passed).map((c: any) => c.label);
        if (!clOk) failed.push("reviewer checklist incomplete");
        if (!b.override_reason?.trim()) throw new Error("Approval blocked: " + failed.join("; "));
        upd.override_reason = b.override_reason.trim();
        await store.qa("override", `Approval override on output v${g.version}`, `Failed: ${failed.join("; ")}\nReason: ${upd.override_reason}`, { output_id: g.id });
      }
      upd.status = "approved";
      await store.qa("approved_result", `Approved output v${g.version}`, b.reason || "", { output_id: g.id });
    } else if (b.decision === "reject" || b.decision === "revise") {
      if (!b.reason?.trim()) throw new Error("A reason is required");
      upd.status = b.decision === "reject" ? "rejected" : "revision_requested";
      await store.qa(QA_CATEGORIES.includes(b.qa_category) ? b.qa_category : "user_correction",
        `${b.decision === "reject" ? "Rejected" : "Revision requested"}: output v${g.version}`, b.reason, { output_id: g.id }, !!b.make_lesson);
      if (b.decision === "revise") {
        const er = need(store.s.requests.find((x) => x.id === g.request_id), "Edit request");
        const ner: any = { source_image_id: er.source_image_id, instruction: b.revised_instruction || er.instruction, scope: er.scope,
          edit_mask_id: er.edit_mask_id, protected_mask_id: er.protected_mask_id, composite: er.composite, global_authorized: er.global_authorized,
          allow_object_additions: er.allow_object_additions, area_description: er.area_description || "", status: "draft", created_at: now(), revision_of: g.id };
        ner.analysis = R.analyze(store.s, ner);
        const nid = newId();
        await store.put("requests", nid, ner);
        out.new_edit_request_id = nid;
      }
    } else throw new Error("Unknown decision");
    await store.patch("outputs", g.id, upd);
    await store.audit(`output.${b.decision}`, g.id, { reason: b.reason, override: upd.override_reason || "" });
    return out;
  }],
  ["POST", /^\/api\/projects\/\w+\/generations\/(\w+)\/ai-review$/, async (m) => {
    if (!store.sample) throw new Error("Claude review is not available in this view.");
    const g = need(store.s.outputs.find((x) => x.id === m[1]), "Output");
    const img = need(store.s.images.find((x) => x.id === g.image_id), "Image");
    const r = await store.sample(`Image 1 is the original architectural render. Image 2 is an edited version. The requested change was: "${g.instruction}".
List, as short bullets: (1) whether the requested change is visible and matches the description; (2) any OTHER differences you can see (geometry, objects, equipment, adjacent materials, shadows, separators). If you see none, say so. This is advisory; do not speculate beyond what is visible.`,
      { images: [await shrinkImage(await store.blob(img.asset_id)), await shrinkImage(await store.blob(g.final_asset_id))], modelTier: "complex" });
    await store.patch("outputs", g.id, { ai_review: r.text, ai_review_at: now() });
    return { text: r.text };
  }],
  ["GET", /^\/api\/projects\/\w+\/qa$/, () => ({
    project: [...store.s.qa].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    global: store.s.rules, categories: QA_CATEGORIES,
  })],
  ["POST", /^\/api\/projects\/\w+\/qa$/, async (_m, b) => { await store.qa(b.category, b.title, b.detail, {}, !!b.is_lesson); return ok; }],
  ["PATCH", /^\/api\/projects\/\w+\/qa\/(\w+)$/, async (m, b) => { await store.patch("qa", m[1], b); return ok; }],
  ["POST", /^\/api\/qa\/global$/, async (_m, b) => { await store.db.collection("rules").doc(newId()).set({ title: b.title, active: true, scope: "global", created_at: now() }); return ok; }],
  ["PATCH", /^\/api\/qa\/global\/(\w+)$/, async (m, b) => { await store.db.collection("rules").doc(m[1]).update(b); return ok; }],
  ["GET", /^\/api\/projects\/\w+\/audit$/, () => ({ events: [...store.s.audit].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 500), provider_calls: [] })],
  // ---- NODE 07 round trip
  ["POST", /^\/api\/projects\/\w+\/runs\/plan$/, (_m, b) => {
    const er = need(store.s.requests.find((x) => x.id === b.edit_request_id), "Edit request");
    const gate = R.executionGate(store.s, er);
    return { gate, ready: gate.ok && er.status === "approved", prompt: er.analysis?.prompt || "", er };
  }],
  ["POST", /^\/api\/projects\/\w+\/runs$/, async (_m, b) => {
    const er = need(store.s.requests.find((x) => x.id === b.edit_request_id), "Edit request");
    const gate = R.executionGate(store.s, er);
    if (!gate.ok || er.status !== "approved") throw new Error("Execution is blocked. Resolve the listed modules first.");
    const img = need(store.s.images.find((x) => x.id === er.source_image_id), "Image");
    if ((await I.sha256(await store.blob(img.asset_id))) !== img.sha256) { store.s.hashFailures.add(img.id); throw new Error("The source image fingerprint does not match. Run refused."); }
    const id = newId();
    await store.put("runs", id, { request_id: er.id, image_id: img.id, engine: "chatgpt", prompt: er.analysis.prompt, status: "awaiting_result", created_at: now(), created_by: store.me });
    await store.audit("run.start", id, { engine: "chatgpt", request: er.id });
    return { id };
  }],
  ["POST", /^\/api\/projects\/\w+\/runs\/(\w+)\/result$/, async (m, b: FormData) => {
    const run = need(store.s.runs.find((x) => x.id === m[1]), "Run");
    try { return { output_id: await importResult(run, b.get("file") as Blob) }; }
    catch (e: any) {
      await store.qa("failed_generation", "Returned image could not be used", String(e?.message || e), { run_id: run.id });
      throw e;
    }
  }],
  ["POST", /^\/api\/projects\/\w+\/runs\/(\w+)\/cancel$/, async (m) => { await store.patch("runs", m[1], { status: "cancelled" }); return ok; }],
];

export async function route(method: string, url: string, body?: any) {
  const [path, qs] = url.split("?");
  for (const [mth, re, h] of routes) {
    if (mth !== method) continue;
    const m = path.match(re);
    if (m) return h(m, body, new URLSearchParams(qs || ""));
  }
  throw new Error(`Not available in this edition: ${method} ${path}`);
}

// ------------------------------------------------------------------ files for display / download
export async function fileBlob(path: string, params: Record<string, any> = {}): Promise<Blob> {
  const s = store.s;
  let m = path.match(/\/documents\/(\w+)\/file$/);
  if (m) { const d = need(s.documents.find((x) => x.id === m![1]), "Document"); if (!d.asset_id) throw new Error("The original file is not stored here."); return store.blob(d.asset_id); }
  m = path.match(/\/images\/(\w+)\/file$/);
  if (m) return store.blob(need(s.images.find((x) => x.id === m![1]), "Image").asset_id);
  m = path.match(/\/images\/(\w+)\/prepared$/);
  if (m) return preparedImage(need(s.images.find((x) => x.id === m![1]), "Image"));
  m = path.match(/\/masks\/(\w+)\/file$/);
  if (m) { const mk = need(R.findMask(s, m[1]), "Mask"); return store.blob(mk.asset_id); }
  m = path.match(/\/images\/(\w+)\/mask-preview$/);
  if (m) {
    const img = need(s.images.find((x) => x.id === m![1]), "Image");
    const src = await I.blobToPx(await store.blob(img.asset_id));
    const er = { scope: "local", edit_mask_id: params.edit_mask_id, protected_mask_id: params.protected_mask_id };
    if (!er.edit_mask_id) { const r = new Uint8Array(img.width * img.height); return I.pxToPng(I.overlayPx(src, r, null)); }
    const { region, prot } = await loadRegion(er, img);
    return I.pxToPng(I.overlayPx(src, region, prot));
  }
  m = path.match(/\/generations\/(\w+)\/file$/);
  if (m) {
    const g = need(s.outputs.find((x) => x.id === m![1]), "Output");
    const img = need(s.images.find((x) => x.id === g.image_id), "Image");
    const v = params.variant || "final";
    if (v === "final") return store.blob(g.final_asset_id);
    if (v === "raw") return store.blob(g.raw_asset_id);
    if (v === "source") return store.blob(img.asset_id);
    const src = await I.blobToPx(await store.blob(img.asset_id));
    if (v === "diff") return I.pxToPng(I.diffPx(src, await I.blobToPx(await store.blob(g.final_asset_id))));
    if (v === "mask") {
      const er = need(s.requests.find((x) => x.id === g.request_id), "Edit request");
      const { region, prot } = await loadRegion(er, img);
      return I.pxToPng(I.overlayPx(src, region, prot));
    }
  }
  throw new Error("Unknown file");
}

export function fileKey(path: string, params: Record<string, any> = {}) {
  const q = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${v}`).join("&");
  return q ? `${path}?${q}` : path;
}
export function fileUrlFor(key: string): Promise<string> {
  const [path, qs] = key.split("?");
  const params = Object.fromEntries(new URLSearchParams(qs || ""));
  const direct = path.match(/\/(images|documents)\/(\w+)\/file$/) || path.match(/\/masks\/(\w+)\/file$/);
  if (direct && !params.variant) {
    // Stored files are served by the platform directly.
    const s = store.s;
    let id: string | undefined;
    if (path.includes("/images/")) id = s.images.find((x) => x.id === path.split("/").slice(-2)[0])?.asset_id;
    else if (path.includes("/documents/")) id = s.documents.find((x) => x.id === path.split("/").slice(-2)[0])?.asset_id;
    else id = R.findMask(s, path.split("/").slice(-2)[0])?.asset_id;
    if (id) return Promise.resolve("/_blob/" + id);
  }
  if (path.includes("/generations/") && (params.variant === "final" || params.variant === "raw" || params.variant === "source")) {
    const g = store.s.outputs.find((x) => x.id === path.split("/").slice(-2)[0]);
    const img = g && store.s.images.find((x) => x.id === g.image_id);
    const id = params.variant === "final" ? g?.final_asset_id : params.variant === "raw" ? g?.raw_asset_id : img?.asset_id;
    if (id) return Promise.resolve("/_blob/" + id);
  }
  return store.derived(key, () => fileBlob(path, params));
}

export async function saveFile(key: string, filename: string) {
  if (!store.downloads) throw new Error("Saving files is not available in this view.");
  const [path, qs] = key.split("?");
  const blob = await fileBlob(path, Object.fromEntries(new URLSearchParams(qs || "")));
  return store.downloads.save({ filename, data: blob });
}
