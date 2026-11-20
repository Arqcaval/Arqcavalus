// Document intake engine (browser port of backend/app/ingestion). Every produced record carries a
// source reference and the evidence text it was derived from. Nothing is inferred from images.

export interface Table { ref: string; rows: string[][]; rowRefs: string[] }
export interface Extracted {
  kind: "pdf" | "image" | "table" | "text" | "cad" | "unknown";
  pages: [string, string][];
  tables: Table[];
  image?: { width: number; height: number };
  pageCount: number;
  warnings: string[];
  unsupported?: string;
}
export interface Proposed {
  module_key: string; record_type: string; key: string; data: Record<string, any>;
  source_ref: string; evidence: string; confidence: number; notes: string[];
}

export const IMAGE_EXT = ["png", "jpg", "jpeg", "webp"];
export const CAD_EXT = ["dwg", "rvt", "dxf", "rfa"];
export const SUPPORTED_EXT = ["pdf", ...IMAGE_EXT, "csv", "xlsx", "txt", "md", "text", "spec"];

declare const pdfjsLib: any;
declare const XLSX: any;

const clean = (v: any) => (v == null ? "" : String(v).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim());
export const fullText = (ex: Extracted) => ex.pages.map((p) => p[1]).join("\n");

function parseCsv(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] || "";
  const delim = [",", ";", "\t", "|"].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.map((r) => r.map(clean)).filter((r) => r.some(Boolean));
}

async function extractPdf(buf: ArrayBuffer): Promise<Extracted> {
  const out: Extracted = { kind: "pdf", pages: [], tables: [], pageCount: 0, warnings: [] };
  if (typeof pdfjsLib === "undefined") throw new Error("PDF reader did not load");
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  out.pageCount = pdf.numPages;
  const max = Math.min(pdf.numPages, 300);
  if (pdf.numPages > max) out.warnings.push(`Only the first ${max} of ${pdf.numPages} pages were processed.`);
  for (let i = 1; i <= max; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    // Rebuild lines from y positions.
    const lines = new Map<number, { x: number; s: string }[]>();
    for (const it of tc.items as any[]) {
      if (!it.str) continue;
      const y = Math.round(it.transform[5]);
      const key = [...lines.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key)!.push({ x: it.transform[4], s: it.str });
    }
    const text = [...lines.entries()].sort((a, b) => b[0] - a[0])
      .map(([, parts]) => parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(" ").replace(/\s+/g, " ").trim())
      .filter(Boolean).join("\n");
    out.pages.push([`page ${i}`, text]);
  }
  if (!fullText(out).trim()) out.warnings.push("This PDF has no text layer (scanned drawing?). Use “Read with Claude” or enter the data manually.");
  return out;
}

function extractXlsx(buf: ArrayBuffer): Extracted {
  if (typeof XLSX === "undefined") throw new Error("Spreadsheet reader did not load");
  const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
  const out: Extracted = { kind: "table", pages: [], tables: [], pageCount: wb.SheetNames.length, warnings: [] };
  for (const name of wb.SheetNames) {
    const raw: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" });
    const rows: string[][] = [], refs: string[] = [];
    raw.forEach((r, i) => { const v = r.map(clean); if (v.some(Boolean)) { rows.push(v); refs.push(`sheet '${name}' row ${i + 1}`); } });
    if (rows.length) {
      out.tables.push({ ref: `sheet '${name}'`, rows, rowRefs: refs });
      out.pages.push([`sheet '${name}'`, rows.map((r) => r.join(" | ")).join("\n")]);
    }
  }
  return out;
}

export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bmp = await createImageBitmap(blob);
  const r = { width: bmp.width, height: bmp.height };
  bmp.close();
  return r;
}

export async function extract(ext: string, file: Blob): Promise<Extracted> {
  ext = ext.toLowerCase();
  const empty = (kind: Extracted["kind"]): Extracted => ({ kind, pages: [], tables: [], pageCount: 0, warnings: [] });
  if (ext === "pdf") return extractPdf(await file.arrayBuffer());
  if (IMAGE_EXT.includes(ext)) {
    const out = empty("image");
    out.image = await imageSize(file);
    if (out.image.width * out.image.height > 40_000_000) throw new Error("Image exceeds 40 megapixels");
    out.pageCount = 1;
    return out;
  }
  if (ext === "csv") {
    const rows = parseCsv((await file.text()).replace(/^﻿/, ""));
    const out = empty("table");
    out.pageCount = 1;
    out.tables.push({ ref: "csv", rows, rowRefs: rows.map((_, i) => `row ${i + 1}`) });
    out.pages.push(["csv", rows.map((r) => r.join(" | ")).join("\n")]);
    return out;
  }
  if (ext === "xlsx") return extractXlsx(await file.arrayBuffer());
  if (["txt", "md", "text", "spec"].includes(ext)) {
    const out = empty("text");
    out.pageCount = 1;
    out.pages.push(["text", (await file.text()).replace(/^﻿/, "")]);
    return out;
  }
  if (CAD_EXT.includes(ext)) {
    const out = empty("cad");
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (ext === "dwg") out.unsupported = `DWG file recognised (header '${String.fromCharCode(...head.slice(0, 6))}'). DWG drawings cannot be read here. Export the sheets to PDF and upload those.`;
    else out.unsupported = "Revit file recognised. Revit models cannot be read here. Export schedules to CSV/XLSX and sheets to PDF instead.";
    return out;
  }
  const out = empty("unknown");
  out.unsupported = `File type .${ext} is not supported.`;
  return out;
}

// ---------------------------------------------------------------- classification
export const DOC_TYPES: Record<string, string> = {
  finish_schedule: "Finish schedule / material specification",
  equipment_schedule: "Equipment schedule",
  equipment_plan: "Equipment / food service plan",
  cut_sheet: "Manufacturer cut sheet / installation document",
  architectural_drawing: "Architectural drawing (plan / elevation / section)",
  project_description: "Project description / metadata",
  specification: "Written specification",
  design_direction: "Design direction / visual intent",
  source_image: "Source render (e.g. Enscape)",
  reference_image: "Reference image (not a source render)",
  cad_unsupported: "CAD model (not read)",
  unknown: "Unclassified",
};
export const TYPE_MODULES: Record<string, string[]> = {
  finish_schedule: ["N02"], equipment_schedule: ["N03"], equipment_plan: ["N03", "N01"], cut_sheet: ["N03"],
  architectural_drawing: ["N01"], project_description: ["N01"], specification: ["N02", "N01"], design_direction: ["N04"],
  source_image: ["N05"], reference_image: ["N04"], cad_unsupported: [], unknown: [],
};
const KEYWORDS: Record<string, string[]> = {
  finish_schedule: ["finish schedule", "finish legend", "material schedule", "\\bsherwin[- ]williams\\b", "\\bformica\\b", "\\bwilsonart\\b",
    "\\bbenjamin moore\\b", "\\beverform\\b", "\\blaminate\\b", "\\bsolid surface\\b", "\\bSW ?\\d{4}\\b", "\\beggshell\\b", "\\bfinish code\\b", "\\bpaint\\b"],
  equipment_schedule: ["equipment schedule", "food ?service equipment", "\\bitem (no|#)", "\\bqty\\b", "\\bmodel\\b", "\\bmfr\\b", "\\bmanufacturer\\b",
    "\\bfryer\\b", "\\brefrigerat", "\\bice machine\\b", "\\bfreezer\\b", "\\bkw\\b|\\bvolts?\\b|\\bamps?\\b"],
  equipment_plan: ["equipment plan", "food ?service plan", "kitchen equipment plan", "\\bFS-?\\d"],
  cut_sheet: ["cut sheet", "specification sheet", "installation (instructions|manual)", "\\bwarranty\\b"],
  architectural_drawing: ["floor plan", "\\belevation\\b", "\\bsection\\b", "reflected ceiling plan", "\\bscale\\s*:", "\\bsheet\\b", "\\b[A-Z]-?\\d{3}\\b", "\\bdetail\\b"],
  project_description: ["\\bproject (name|description|number)\\b", "\\bclient\\b", "\\bowner\\b", "\\bscope\\b", "\\baddress\\b", "\\barchitect\\b"],
  specification: ["\\bsection \\d{2} ?\\d{2} ?\\d{2}\\b", "\\bpart [123]\\b", "\\bsubmittals?\\b", "\\bexecution\\b"],
  design_direction: ["design direction", "visual intent", "\\bmood\\b", "render(ing)? notes", "\\bvisualization\\b"],
};
const NAME_HINTS: Record<string, string[]> = {
  finish_schedule: ["finish", "material", "fin_sch", "finishes"],
  equipment_schedule: ["equipment schedule", "equip_sch", "eq schedule", "equipment_schedule", "fses"],
  equipment_plan: ["equipment plan", "equip_plan", "fs plan", "equipment_plan", "kitchen plan"],
  cut_sheet: ["cut sheet", "cutsheet", "spec sheet", "install"],
  architectural_drawing: ["plan", "elevation", "section", "rcp", "drawing", "sheet"],
  project_description: ["description", "project info", "brief", "narrative", "metadata"],
  design_direction: ["direction", "intent", "notes"],
  source_image: ["enscape", "render", "view", "camera", "vis", "persp"],
};

export function classify(filename: string, ex: Extracted): [string, number, string[]] {
  const name = filename.toLowerCase();
  if (ex.kind === "cad") return ["cad_unsupported", 1, [ex.unsupported || ""]];
  if (ex.kind === "image") {
    const isRender = NAME_HINTS.source_image.some((h) => name.includes(h));
    for (const t of ["architectural_drawing", "equipment_plan"]) {
      const h = NAME_HINTS[t].find((x) => name.includes(x));
      if (h && !isRender) return [t, 0.55, [`image filename contains '${h}'`]];
    }
    const ev = [`raster image ${ex.image!.width}×${ex.image!.height}`];
    const hint = NAME_HINTS.source_image.find((h) => name.includes(h));
    if (hint) return ["source_image", 0.85, [...ev, `filename contains '${hint}'`]];
    return ["source_image", 0.5, [...ev, "no render keywords in the filename; please confirm it is an authorised source render"]];
  }
  const text = fullText(ex).slice(0, 200_000);
  const scores: Record<string, number> = {}, evidence: Record<string, string[]> = {};
  for (const [t, pats] of Object.entries(KEYWORDS)) {
    let n = 0; const ev: string[] = [];
    for (const p of pats) {
      const m = text.match(new RegExp(p, "gi"));
      if (m) { n += Math.min(m.length, 5); ev.push(`matched '${p.replace(/\\\\/g, "\\")}' ×${m.length}`); }
    }
    let score = n;
    for (const h of NAME_HINTS[t] || []) if (name.includes(h)) { score += 4; ev.push(`filename contains '${h}'`); }
    if (t === "finish_schedule") {
      const codes = text.match(/^\s*"?(P|PT|PL|SS|WCP|ACT|CPT|CT|RB|ST|QZ|LVT|WD|MTL|GL)-?\d{1,3}\b/gm);
      if (codes) { score += Math.min(codes.length, 10) * 1.5; ev.push(`${codes.length} finish-code rows`); }
    }
    scores[t] = score; evidence[t] = ev;
  }
  if (ex.kind === "table") { scores.equipment_plan *= 0.3; scores.architectural_drawing *= 0.3; }
  const best = Object.keys(scores).reduce((a, b) => (scores[b] > scores[a] ? b : a));
  const total = Object.values(scores).reduce((a, b) => a + b, 0) || 1;
  if (scores[best] < 2) return ["unknown", 0, ["no strong indicators found; classify manually"]];
  return [best, Math.round(Math.min(0.95, scores[best] / total + 0.15) * 100) / 100, evidence[best].slice(0, 8)];
}

// ---------------------------------------------------------------- module parsers
const CODE_RE = /^[A-Z]{1,4}-?\d{1,3}[A-Z]?$/;
const TAG_RE = /^(?:[A-Z]{1,4}-?)?\d{1,4}[A-Z]?$/;
const MANUFACTURERS = ["Sherwin-Williams", "Benjamin Moore", "PPG", "Formica", "Wilsonart", "Pionite", "Corian", "Armstrong", "Daltile",
  "Crossville", "Mohawk", "Interface", "Shaw", "Caesarstone", "Cambria", "Silestone", "Rockfon", "USG", "Johnsonite", "Tarkett", "Roppe",
  "Hoshizaki", "Manitowoc", "True", "Traulsen", "Vulcan", "Frymaster", "Pitco", "Hobart", "Rational", "Turbochef", "Merrychef", "Scotsman",
  "Beverage-Air", "Perlick", "Krowne", "Eagle", "Advance Tabco", "Bunn", "Vollrath", "Hatco", "Delfield", "Victory", "Continental"];
const SHEEN = ["flat", "matte", "eggshell", "satin", "semi-gloss", "gloss", "low sheen", "honed", "polished", "textured", "suede",
  "natural grain", "plain slice"];
const CATEGORY_BY_PREFIX: [string, string][] = [["WCP", "wood_paneling"], ["WP", "wood_paneling"], ["WD", "wood_paneling"],
  ["PLAM", "laminate"], ["PL", "laminate"], ["SS", "solid_surface"], ["ACT", "acoustic_ceiling"], ["CPT", "carpet"],
  ["LVT", "resilient_flooring"], ["RB", "resilient_base"], ["CT", "tile"], ["PT", "paint"], ["T", "tile"], ["ST", "stone"],
  ["QZ", "quartz"], ["MTL", "metal"], ["GL", "glass"], ["P", "paint"]];
const CATEGORY_KEYWORDS: [string, RegExp[]][] = [
  ["paint", [/\bpaint\b/i, /sherwin/i, /benjamin moore/i, /\bppg\b/i, /\bSW ?\d{4}\b/i, /eggshell/i, /semi-gloss/i]],
  ["laminate", [/laminate/i, /\bplam\b/i, /formica \d{4,5}/i, /wilsonart/i, /pionite/i]],
  ["solid_surface", [/solid surface/i, /everform/i, /corian/i]],
  ["tile", [/\btile\b/i, /porcelain/i, /ceramic/i, /mosaic/i]],
  ["wood_paneling", [/veneer/i, /woodworks/i, /wood panel/i, /paneling/i, /\bwood ceiling\b/i]],
  ["acoustic_ceiling", [/acoustic/i, /ceiling tile/i]],
  ["stone", [/granite/i, /marble/i, /quartzite/i]],
  ["quartz", [/\bquartz\b/i, /caesarstone/i, /cambria/i, /silestone/i]],
  ["metal", [/stainless/i, /aluminum/i, /\bmetal\b/i]],
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function materialCategory(code: string, text: string): [string, number, string] {
  const prefix = (code.toUpperCase().match(/^[A-Z]+/) || [""])[0];
  const pcat = CATEGORY_BY_PREFIX.find(([p]) => p === prefix)?.[1];
  const kcat = CATEGORY_KEYWORDS.find(([, ps]) => ps.some((p) => p.test(text)))?.[0];
  if (pcat && kcat && pcat === kcat) return [pcat, 0.95, `code prefix and description agree (${pcat})`];
  if (pcat && kcat) return [kcat, 0.6, `description indicates ${kcat} but code prefix suggests ${pcat} — please review`];
  if (kcat) return [kcat, 0.75, `description indicates ${kcat}`];
  if (pcat) return [pcat, 0.6, `inferred from code prefix only (${pcat})`];
  return ["other", 0.3, "material category not determinable"];
}
const findMfr = (t: string) => MANUFACTURERS.find((m) => new RegExp(`\\b${esc(m)}\\b`, "i").test(t)) || "";

function splitProduct(text: string, mfr: string): Record<string, any> {
  const d: Record<string, any> = {};
  const rest = (mfr ? text.replace(new RegExp(esc(mfr), "ig"), "") : text).replace(/^[\s\-–,:;]+|[\s\-–,:;]+$/g, "");
  let m = rest.match(/\b(SW|BM|PPG)\s?-?(\d{4})\b/);
  if (m) {
    d.color_code = `${m[1]} ${m[2]}`;
    const after = rest.slice((m.index || 0) + m[0].length).replace(/^[\s\-–,:;]+/, "");
    d.color_name = after.split(/[,;(]| - /)[0].trim();
  } else {
    m = rest.match(/\b(Everform\s+)?(\d{3,5}(?:-\d{2})?)\b\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})/);
    if (m) { d.product_number = (m[1] || "") + m[2]; d.color_name = m[3].trim(); }
  }
  const s = SHEEN.find((x) => new RegExp(`\\b${esc(x)}\\b`, "i").test(text));
  if (s) d.texture = s;
  const dim = text.match(/\d+(?:\.\d+)?\s?(?:"|'|in\b|mm\b|cm\b|ft\b)(?:\s?[x×]\s?\d+(?:\.\d+)?\s?(?:"|'|in\b|mm\b|cm\b|ft\b))*/);
  if (dim) d.dimensions = dim[0].trim();
  d.product = rest.trim();
  return d;
}

const HEADER_ALIASES: Record<string, string[]> = {
  code: ["code", "mark", "tag", "finish code", "designation", "symbol", "key", "finish", "id", "item", "item no", "item #", "no", "no."],
  manufacturer: ["manufacturer", "mfr", "mfg", "vendor", "brand"],
  product: ["product", "description", "product name", "material", "item description", "name", "color/finish", "color", "style"],
  color: ["color", "colour", "color name", "pattern"],
  texture: ["texture", "sheen", "finish type", "surface"],
  dimensions: ["size", "dimensions", "dimension", "thickness", "nominal size"],
  application: ["location", "application", "use", "where used", "remarks/location", "area", "room"],
  drawing_ref: ["drawing", "sheet", "reference", "ref", "detail"],
  model: ["model", "model no", "model #", "model number", "catalog no"],
  qty: ["qty", "quantity", "count"],
  remarks: ["remarks", "notes", "comments"],
  electrical: ["electrical", "elec", "volts", "voltage", "kw", "amps"],
};
function mapHeader(row: string[]): Record<string, number> {
  const mp: Record<string, number> = {};
  row.forEach((cell, i) => {
    const c = cell.toLowerCase().trim().replace(/:$/, "");
    for (const [f, al] of Object.entries(HEADER_ALIASES)) if (al.includes(c) && !(f in mp)) { mp[f] = i; break; }
  });
  return mp;
}
function findHeader(t: Table, need: string): [number, Record<string, number>] | null {
  for (let i = 0; i < Math.min(15, t.rows.length); i++) { const mp = mapHeader(t.rows[i]); if (need in mp) return [i, mp]; }
  return null;
}

export function parseFinishes(ex: Extracted): Proposed[] {
  const out = new Map<string, Proposed>();
  for (const t of ex.tables) {
    const h = findHeader(t, "code");
    if (!h) continue;
    const [hi, mp] = h;
    if (!["manufacturer", "product", "color"].some((f) => f in mp)) continue;
    for (let r = hi + 1; r < t.rows.length; r++) {
      const row = t.rows[r];
      const get = (f: string) => (f in mp && mp[f] < row.length ? row[mp[f]].trim() : "");
      const code = get("code").toUpperCase().replace(/\s/g, "");
      if (!CODE_RE.test(code)) continue;
      const joined = row.filter(Boolean).join(" | ");
      const mfr = get("manufacturer") || findMfr(joined);
      const prodTxt = [get("product"), get("color")].filter(Boolean).join(" ");
      const data: Record<string, any> = splitProduct(prodTxt || joined, mfr);
      const extra: Record<string, string> = { code, manufacturer: mfr, texture: get("texture") || data.texture || "",
        dimensions: get("dimensions") || data.dimensions || "", application: get("application"), drawing_refs: get("drawing_ref"), remarks: get("remarks") };
      for (const [k, v] of Object.entries(extra)) if (v) data[k] = v;
      const [cat, conf, why] = materialCategory(code, joined);
      data.category = cat;
      out.set(code, { module_key: "N02", record_type: "finish", key: code, data, source_ref: t.rowRefs[r] || t.ref, evidence: joined, confidence: Math.min(conf, 0.95), notes: [why] });
    }
  }
  const lineRe = /^\s*([A-Z]{1,4}-?\d{1,3}[A-Z]?)\s*(?:[:=\-–|\t]|\s{2,}|\s)\s*(.{6,240})$/;
  for (const [ref, text] of ex.pages) {
    text.split(/\r?\n/).forEach((line, idx) => {
      const m = line.match(lineRe);
      if (!m) return;
      const code = m[1].replace(/\s/g, ""), desc = m[2].trim();
      const mfr = findMfr(desc);
      if (!mfr && !/\b(SW|BM) ?\d{4}\b|laminate|solid surface|tile|veneer|paint/i.test(desc)) return;
      if (out.has(code)) return;
      const data: Record<string, any> = { ...splitProduct(desc, mfr), code, manufacturer: mfr };
      const loc = desc.match(/(?:location|application|at|@)\s*[:\-]\s*(.+)$/i);
      if (loc) data.application = loc[1].trim();
      const refs = desc.match(/\b[A-Z]{1,2}-?\d{1,3}\.\d{1,2}\b|\b[A-Z]-\d{3}\b/g);
      if (refs) data.drawing_refs = refs.join(", ");
      const [cat, conf, why] = materialCategory(code, desc);
      data.category = cat;
      out.set(code, { module_key: "N02", record_type: "finish", key: code, data, source_ref: `${ref} line ${idx + 1}`, evidence: line.trim(),
        confidence: Math.round(conf * 90) / 100, notes: [why, "parsed from free text"] });
    });
  }
  return [...out.values()];
}

export function parseEquipment(ex: Extracted): Proposed[] {
  const out = new Map<string, Proposed>();
  for (const t of ex.tables) {
    const h = findHeader(t, "code");
    if (!h) continue;
    const [hi, mp] = h;
    if (!("model" in mp) && !("manufacturer" in mp)) continue;
    for (let r = hi + 1; r < t.rows.length; r++) {
      const row = t.rows[r];
      const get = (f: string) => (f in mp && mp[f] < row.length ? row[mp[f]].trim() : "");
      const tag = get("code").toUpperCase().replace(/\s/g, "");
      if (!TAG_RE.test(tag)) continue;
      const joined = row.filter(Boolean).join(" | ");
      const data: Record<string, any> = {};
      const vals: Record<string, string> = { tag, description: get("product"), manufacturer: get("manufacturer") || findMfr(joined), model: get("model"),
        qty: get("qty"), dimensions: get("dimensions"), schedule_location: get("application"), electrical: get("electrical"), remarks: get("remarks") };
      for (const [k, v] of Object.entries(vals)) if (v) data[k] = v;
      data.location_verified = false; // never validated from a schedule alone
      const missing = ["manufacturer", "model", "dimensions"].filter((f) => !data[f]);
      out.set(tag, { module_key: "N03", record_type: "equipment", key: tag, data, source_ref: t.rowRefs[r] || t.ref, evidence: joined,
        confidence: Math.max(0.3, Math.round((0.9 - 0.15 * missing.length) * 100) / 100), notes: missing.length ? [`missing: ${missing.join(", ")}`] : [] });
    }
  }
  return [...out.values()];
}

export function findEquipmentOnPlan(ex: Extracted, tags: string[]): Proposed[] {
  const res: Proposed[] = [];
  for (const tag of tags) {
    const pat = new RegExp(`(?<![A-Z0-9-])${esc(tag)}(?![A-Z0-9])`);
    outer: for (const [ref, text] of ex.pages) {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (pat.test(lines[i])) {
          res.push({ module_key: "N03", record_type: "equipment_location", key: tag, data: { tag, plan_ref: `${ref} line ${i + 1}`, found_on_plan: true },
            source_ref: `${ref} line ${i + 1}`, evidence: lines[i].trim().slice(0, 300), confidence: 0.6, notes: ["tag text found on plan — confirm position visually"] });
          break outer;
        }
      }
    }
  }
  return res;
}

const ROOM_WORDS = ["KITCHEN", "BAR", "SERVERY", "RESTROOM", "TOILET", "MEN", "WOMEN", "STORAGE", "PANTRY", "LOBBY", "OFFICE", "CORRIDOR",
  "VESTIBULE", "DINING", "PATIO", "TERRACE", "MECHANICAL", "JANITOR", "JAN", "PREP", "WALK-IN", "COOLER", "FREEZER", "DISH", "SEATING",
  "LOUNGE", "ENTRY", "HALL", "ELEC", "IT", "LOCKER", "PORCH", "GRILL", "SNACK", "COUNTER", "QUEUE", "PRO SHOP", "HALFWAY HOUSE", "BREAK", "RECEIVING"];

export function parseProject(ex: Extracted, filename: string): Proposed[] {
  const out: Proposed[] = [];
  const seen = new Set<string>();
  const add = (rt: string, key: string, data: any, ref: string, ev: string, conf: number, notes: string[] = []) => {
    const k = rt + "|" + key.toUpperCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ module_key: "N01", record_type: rt, key, data, source_ref: ref, evidence: ev.slice(0, 400), confidence: conf, notes });
  };
  const fields: Record<string, RegExp> = {
    project_name: /^\s*project(?:\s+name)?\s*[:\-–]\s*(.+)$/i,
    project_number: /^\s*(?:project|job)\s*(?:no\.?|number|#)\s*[:\-–]\s*(.+)$/i,
    client: /^\s*(?:client|owner)\s*[:\-–]\s*(.+)$/i,
    address: /^\s*(?:address|location|site)\s*[:\-–]\s*(.+)$/i,
    architect: /^\s*architect\s*[:\-–]\s*(.+)$/i,
    scope: /^\s*scope(?:\s+of\s+work)?\s*[:\-–]\s*(.+)$/i,
    phase: /^\s*(?:phase|issue)\s*[:\-–]\s*(.+)$/i,
  };
  const roomRe = /\b(\d{3}[A-Z]?)\s+([A-Z][A-Z /&\-]{1,40})\b|\b([A-Z][A-Z /&\-]{1,40})\s+(\d{3}[A-Z]?)\b/g;
  const sheetRe = /\b([A-Z]{1,2}-?\d{1,3}(?:\.\d{1,2})?)\s+[-–]?\s*([A-Z][A-Z0-9 ,&/\-]{3,60}?(?:PLAN|ELEVATIONS?|SECTIONS?|DETAILS?|SCHEDULES?|RCP))\b/g;
  const constraintRe = /\b(shall not|do not|must not|must|shall|NIC|not in contract|by owner|existing to remain|protect)\b/i;
  for (const [ref, text] of ex.pages) {
    text.split(/\r?\n/).forEach((line, idx) => {
      const s = line.trim();
      if (!s) return;
      const src = `${ref} line ${idx + 1}`;
      for (const [f, pat] of Object.entries(fields)) {
        const m = s.match(pat);
        if (m) add("project_info", f, { field: f, value: m[1].trim() }, src, s, 0.85);
      }
      for (const m of s.matchAll(sheetRe)) add("drawing_ref", m[1], { sheet: m[1], title: m[2].trim() }, src, s, 0.75);
      for (const m of s.matchAll(roomRe)) {
        const [num, raw] = m[1] ? [m[1], m[2]] : [m[4], m[3]];
        const name = raw.replace(/^[\s\-/&]+|[\s\-/&]+$/g, "");
        if (ROOM_WORDS.some((w) => new RegExp(`\\b${esc(w)}\\b`).test(name)) && name.length <= 40) add("room", `${num} ${name}`, { number: num, name }, src, s, 0.7);
      }
      const rm = s.match(/^\s*rooms?\s*[:\-–]\s*(.+)$/i);
      if (rm) rm[1].split(/[;,]/).map((p) => p.trim()).filter(Boolean).forEach((p) => add("room", p, { name: p }, src, s, 0.8));
      if (constraintRe.test(s) && s.length > 12 && s.length < 300)
        add("constraint", s.slice(0, 120), { text: s }, src, s, 0.55, ["constraint language detected — confirm applicability"]);
    });
  }
  if (!out.some((r) => r.record_type === "project_info" && r.key === "project_name")) {
    const stem = filename.replace(/\.[^.]+$/, "").replace(/[_\-]+/g, " ");
    out.push({ module_key: "N01", record_type: "project_info", key: "project_name_candidate", data: { field: "project_name", value: stem },
      source_ref: "filename", evidence: filename, confidence: 0.2, notes: ["low confidence: derived from filename only"] });
  }
  return out;
}
