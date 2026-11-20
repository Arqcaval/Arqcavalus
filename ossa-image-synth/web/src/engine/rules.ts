// Readiness evaluation (NODE 01–09) and the Visual Intent Engine (NODE 04).
// Browser port of backend/app/modules.py and intent.py.
import type { State } from "../store";

export const MODULES: Record<string, { name: string; critical: boolean | "conditional"; inputs: string }> = {
  N01: { name: "Project Understanding", critical: true, inputs: "Architectural drawings, project metadata, descriptions, plans, elevations, sections" },
  N02: { name: "Finish Schedule Intelligence", critical: "conditional", inputs: "Finish schedules, material specifications, manufacturer references" },
  N03: { name: "Equipment & Food Service Intelligence", critical: "conditional", inputs: "Equipment schedules, equipment plans, cut sheets" },
  N04: { name: "Visual Intent Engine", critical: true, inputs: "Your instructions, project requirements, approved design direction" },
  N05: { name: "Source Image Integrity", critical: true, inputs: "Original Enscape renders / authorised source images" },
  N06: { name: "Learning & QA Log", critical: false, inputs: "Corrections, failures, approvals, lessons" },
  N07: { name: "Oscillator / AI Engine", critical: true, inputs: "Approved edit request, AI image engine" },
  N08: { name: "Output & Validation", critical: false, inputs: "Edited images returned by the AI engine" },
  N09: { name: "Document Intake & Module Mapping", critical: false, inputs: "All uploaded files" },
};

const req = (id: string, label: string, ok: any, required = true, detail = "") => ({ id, label, satisfied: !!ok, required, detail });
const stateOf = (reqs: any[], has: boolean, processing: boolean, error: boolean, pending: boolean) =>
  error ? "ERROR" : processing ? "PROCESSING" : !has ? "EMPTY" : reqs.filter((r) => r.required).every((r) => r.satisfied) && !pending ? "VALIDATED" : "NEEDS_REVIEW";

function docState(s: State, mk: string) {
  const srcs: any[] = [];
  let processing = false, error = false;
  for (const d of s.documents) for (const m of d.mappings || []) {
    if (m.module_key !== mk || m.status === "rejected") continue;
    if (d.status === "processing") processing = true;
    if (d.status === "error") error = true;
    srcs.push({ document_id: d.id, name: d.original_name, mapping: m.status, status: d.status });
  }
  return { processing, error, srcs };
}

export function evalN04(s: State, er?: any) {
  er = er || [...s.requests].sort((a, b) => (b.created_at > a.created_at ? 1 : -1))[0];
  if (!er) return { reqs: [req("request", "An edit request has been described", false)], er: null };
  const a = er.analysis || {};
  const blocks = (a.issues || []).filter((i: any) => i.severity === "block");
  const mask = er.edit_mask_id ? findMask(s, er.edit_mask_id) : null;
  return {
    er,
    reqs: [
      req("request", "Edit request described and analysed", a.categories, true, er.instruction.slice(0, 120)),
      req("no_blockers", "No blocking intent issues", !blocks.length, true, blocks.map((i: any) => i.message).join("; ")),
      req("region", "Edit region authorised (approved mask, or authorised global edit)",
        (er.scope === "local" && mask?.status === "approved") || (er.scope === "global" && er.global_authorized)),
      req("approved", "Edit request approved", er.status === "approved"),
    ],
  };
}

export function findMask(s: State, id: string) {
  for (const i of s.images) for (const m of i.masks || []) if (m.id === id) return { ...m, image_id: i.id };
  return null;
}

export function evaluate(s: State) {
  const out: Record<string, any> = {};
  const recs = (mk: string) => s.records.filter((r) => r.module_key === mk);
  // N01
  {
    const r = recs("N01"), a = r.filter((x) => x.status === "approved");
    const name = a.filter((x) => x.record_type === "project_info" && x.data?.field === "project_name");
    const rooms = a.filter((x) => x.record_type === "room"), sheets = a.filter((x) => x.record_type === "drawing_ref");
    const reqs = [
      req("identity", "Project identity (name) approved", name.length, true, name.map((x) => x.data.value).join(", ")),
      req("rooms", "At least one room / space identified and approved", rooms.length, true, `${rooms.length} approved`),
      req("drawings", "Drawing references (plans/elevations/sections)", sheets.length, false, `${sheets.length} approved`),
      req("constraints", "Design constraints / scope reviewed", !r.some((x) => x.record_type === "constraint" && x.status === "proposed"), false),
    ];
    out.N01 = { reqs, recs: r };
  }
  // N02
  {
    const r = recs("N02").filter((x) => x.record_type === "finish"), a = r.filter((x) => x.status === "approved");
    const incomplete = a.filter((x) => !(x.data.product || x.data.color_name) || !x.data.category || x.data.category === "other").map((x) => x.key);
    const by: Record<string, Set<string>> = {};
    for (const x of r) if (x.status !== "rejected") (by[x.key] ||= new Set()).add(String(x.data.product || "").trim().toLowerCase());
    const conflicts = Object.keys(by).filter((k) => by[k].size > 1);
    const noLoc = a.filter((x) => !x.data.application && !x.data.drawing_refs).map((x) => x.key);
    const pending = r.filter((x) => x.status === "proposed").length;
    out.N02 = { recs: r, reqs: [
      req("finishes", "At least one finish record approved", a.length, true, `${a.length} approved of ${r.length}`),
      req("complete", "Each approved finish has product and material category", a.length && !incomplete.length, true, incomplete.length ? "incomplete: " + incomplete.join(", ") : ""),
      req("conflicts", "No conflicting records for the same finish code", !conflicts.length, true, conflicts.length ? "conflicts: " + conflicts.join(", ") : ""),
      req("reviewed", "All proposed finish records reviewed", !pending, true, `${pending} awaiting review`),
      req("locations", "Application / drawing location for each finish", !noLoc.length, false, noLoc.length ? "missing for: " + noLoc.join(", ") : ""),
    ] };
  }
  // N03
  {
    const r = recs("N03"), eq = r.filter((x) => x.record_type === "equipment"), a = eq.filter((x) => x.status === "approved");
    const plan = s.documents.some((d) => d.doc_type === "equipment_plan" && (d.mappings || []).some((m: any) => m.module_key === "N03" && m.status === "accepted"));
    const unverified = a.filter((x) => !x.data.location_verified).map((x) => x.key);
    const incomplete = a.filter((x) => !(x.data.manufacturer && x.data.model)).map((x) => x.key);
    const pending = r.filter((x) => x.status === "proposed").length;
    out.N03 = { recs: r, reqs: [
      req("schedule", "Equipment schedule records approved", a.length, true, `${a.length} approved of ${eq.length}`),
      req("ids", "Each approved item has manufacturer and model", a.length && !incomplete.length, true, incomplete.length ? "incomplete: " + incomplete.join(", ") : ""),
      req("plan", "Equipment plan available for cross-checking", plan || a.some((x) => x.data.location_verified), true, "A schedule alone cannot establish locations. Upload and accept an equipment plan."),
      req("locations", "Every approved item's location verified against the plan", a.length && !unverified.length, true, unverified.length ? "unverified: " + unverified.join(", ") : ""),
      req("reviewed", "All proposals reviewed", !pending, true, `${pending} awaiting review`),
    ] };
  }
  for (const mk of ["N01", "N02", "N03"]) {
    const { reqs, recs: r } = out[mk];
    const ds = docState(s, mk);
    out[mk] = { requirements: reqs, sources: ds.srcs, state: stateOf(reqs, r.length > 0 || ds.srcs.length > 0, ds.processing, ds.error, r.some((x: any) => x.status === "proposed")),
      counts: { proposed: r.filter((x: any) => x.status === "proposed").length, approved: r.filter((x: any) => x.status === "approved").length } };
  }
  // N04
  {
    const { reqs, er } = evalN04(s);
    out.N04 = { requirements: reqs, sources: [], state: er ? stateOf(reqs, true, false, false, false) : "EMPTY", edit_request_id: er?.id || null };
  }
  // N05
  {
    const auth = s.images.filter((i) => i.status === "authorized");
    const tampered = auth.filter((i) => s.hashFailures.has(i.id)).map((i) => i.label);
    const prot = s.images.reduce((n, i) => n + (i.masks || []).filter((m: any) => m.kind === "protected" && m.status === "approved").length, 0);
    const reqs = [
      req("authorized", "At least one source image authorised", auth.length, true, `${auth.length} authorised of ${s.images.length}`),
      req("integrity", "Stored source files match their original SHA-256", !tampered.length, true, tampered.length ? "MISMATCH: " + tampered.join(", ") : "verified when each run is prepared"),
      req("protected", "Protected regions defined", prot > 0, false, `${prot} approved protected mask(s)`),
    ];
    const ds = docState(s, "N05");
    out.N05 = { requirements: reqs, sources: ds.srcs, counts: { images: s.images.length },
      state: tampered.length || ds.error ? "ERROR" : stateOf(reqs, s.images.length > 0, ds.processing, false, false) };
  }
  // N06
  {
    const n = s.qa.length, lessons = s.qa.filter((q) => q.is_lesson).length;
    out.N06 = { requirements: [req("log", "QA history recorded", n, false, `${n} entries, ${lessons} lessons`)], sources: [], state: n ? "VALIDATED" : "EMPTY" };
  }
  // N07 — the AI engine round trip
  {
    const approved = s.requests.filter((r) => r.status === "approved");
    const runs = [...s.runs].sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
    const last = runs[0];
    const reqs = [
      req("engine", "AI image engine available", true, true, "ChatGPT image editing (manual round trip)"),
      req("request", "An approved edit request to run", approved.length, true),
      req("run", "Latest run returned an edited image", last && last.status === "returned", true, last ? `latest run: ${last.status}` : "no runs yet"),
    ];
    out.N07 = { requirements: reqs, sources: [], mode: "chatgpt",
      state: last?.status === "failed" ? "ERROR" : last?.status === "awaiting_result" ? "PROCESSING" : !approved.length && !last ? "EMPTY" : stateOf(reqs, true, false, false, false) };
  }
  // N08
  {
    const g = [...s.outputs].sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
    const st = !g.length ? "EMPTY" : g[0].status === "approved" ? "VALIDATED" : "NEEDS_REVIEW";
    out.N08 = { requirements: [
      req("output", "Edited output available", g.length, true, `${g.length} version(s)`),
      req("decision", "Latest output reviewed", g.length && g[0].status !== "pending_review", true, g[0]?.status || ""),
    ], sources: [], state: st };
  }
  // N09
  {
    const docs = s.documents, maps = docs.flatMap((d) => d.mappings || []);
    const unsupported = docs.filter((d) => d.status === "unsupported").map((d) => d.original_name);
    const pendingMaps = maps.filter((m: any) => m.status === "proposed").length;
    const st = !docs.length ? "EMPTY" : docs.some((d) => d.status === "processing") ? "PROCESSING" : docs.some((d) => d.status === "error") ? "ERROR"
      : pendingMaps || docs.some((d) => d.doc_type === "unknown") ? "NEEDS_REVIEW" : "VALIDATED";
    out.N09 = { requirements: [
      req("docs", "Documents uploaded", docs.length, true, `${docs.length} file(s)`),
      req("classified", "All documents classified", docs.length && !docs.some((d) => d.doc_type === "unknown")),
      req("mappings", "All proposed module mappings reviewed", !pendingMaps, true, `${pendingMaps} awaiting review`),
      req("unsupported", "No unsupported files awaiting conversion", !unsupported.length, false, unsupported.join(", ")),
    ], sources: [], state: st };
  }
  for (const [k, v] of Object.entries(out)) {
    Object.assign(v, { key: k, ...MODULES[k] });
    v.missing = v.requirements.filter((r: any) => r.required && !r.satisfied).map((r: any) => r.label + (r.detail ? ` — ${r.detail}` : ""));
    v.readiness = v.state === "VALIDATED" ? "satisfied" : ["EMPTY", "ERROR"].includes(v.state) ? "blocked" : "partial";
  }
  return out;
}

/** Which modules must be VALIDATED before an edit can be run. */
export function executionGate(s: State, er: any) {
  const states = evaluate(s);
  const n04 = evalN04(s, er);
  states.N04 = { ...states.N04, requirements: n04.reqs, state: stateOf(n04.reqs, true, false, false, false),
    missing: n04.reqs.filter((r: any) => r.required && !r.satisfied).map((r: any) => r.label + (r.detail ? ` — ${r.detail}` : "")) };
  const required: string[] = er.analysis?.requires_modules || ["N01", "N04", "N05"];
  // Only the signal to process (the image) is mandatory. Anything else missing runs at the user's responsibility.
  const warnings = required.filter((mk) => !["N05", "N07"].includes(mk) && states[mk].state !== "VALIDATED")
    .map((mk) => ({ module: mk, name: MODULES[mk].name, state: states[mk].state, missing: states[mk].missing }));
  for (const i of (er.analysis?.issues || []).filter((x: any) => x.severity === "warn")) warnings.push({ module: "N04", name: "Visual Intent Engine", state: "WARNING", missing: [i.message] });
  const blockers: any[] = [];
  const img = s.images.find((i) => i.id === er.source_image_id);
  if (!img) blockers.push({ module: "N05", name: "Source Image Integrity", state: "BLOCKED", missing: ["No image selected. The image is the one thing an edit cannot run without."] });
  if (!String(er.instruction || "").trim()) blockers.push({ module: "N04", name: "Visual Intent Engine", state: "BLOCKED", missing: ["Describe the change."] });
  return { ok: !blockers.length, blockers, warnings, required_modules: required };
}

// ---------------------------------------------------------------- NODE 04 intent
const CATEGORIES: Record<string, RegExp[]> = {
  material_correction: [/\bfinish/, /\bmaterial/, /\blaminate/, /\bpaint/, /\bcolou?r\b/, /\breplace .* with\b/, /\bchange .* to\b/, /\bwood\b/,
    /\btile\b/, /\bveneer/, /\bsolid surface/, /\bcounter ?top/, /\bbacksplash/, /\bcabinet/, /\bpanel/],
  lighting_adjustment: [/\blight(ing)?\b/, /\bbright/, /\bexposure/, /\bwarm(er|th)?\b/, /\bcool(er)?\b light/, /\bdaylight/, /\bglow/, /\bdim\b/, /\bluminaire/],
  equipment_presentation: [/\bequipment/, /\bfryer/, /\bcooler\b/, /\brefrigerat/, /\boven/, /\bhood\b/, /\bice machine/, /\bfreezer/, /\bgriddle/, /\bmerchandiser/, /\bstainless/],
  object_addition: [/\badd(ing)?\b/, /\binsert/, /\bplace (a|an|some)\b/, /\binclude (a|an|some)\b/, /\bplants?\b/, /\bpeople\b/, /\bdecor/, /\bflowers?\b/, /\bartwork/],
  global_improvement: [/\boverall\b/, /\bentire (image|scene|render)/, /\bwhole (image|scene)/, /\bphotoreal/, /\brealism\b/, /\benhance\b/, /\bimage quality/],
};
const GEOMETRY = [/\bmove\b/, /\brelocate/, /\bresize/, /\benlarge/, /\bshrink/, /\bwiden/, /\bnarrow/, /\bextend/, /\breshape/,
  /\bremove (the )?(wall|column|window|door|opening|ceiling)/, /\braise the ceiling/, /\blower the ceiling/, /\bchange (the )?(camera|perspective|angle|view)/, /\brotate/];
export const GLOBAL_RULES = [
  "Preserve camera position, focal length, perspective and framing exactly.",
  "Preserve all architecture and geometry: walls, openings, glazing, millwork profiles, ceiling and floor patterns, material joint layouts.",
  "Do not move, add, remove or restyle equipment.",
  "Do not change shadows or reflections outside the edit region.",
  "A change of material colour is not a change of geometry.",
  "Do not interpret a shadow as a different material.",
];

export function analyze(s: State, er: any) {
  const text: string = er.instruction || "", low = text.toLowerCase();
  let cats = Object.keys(CATEGORIES).filter((c) => CATEGORIES[c].some((p) => p.test(low)));
  const issues: any[] = [];
  if (GEOMETRY.some((p) => p.test(low))) issues.push({ severity: "warn", code: "geometry_change",
    message: "The instruction asks for a geometric change (move, resize, remodel or camera). Image Synth only changes appearance inside an authorised area. Change the model and re-render in Enscape instead." });
  if (cats.includes("object_addition") && !er.allow_object_additions) issues.push({ severity: "warn", code: "object_addition",
    message: "The instruction appears to add objects. Object additions need explicit approval (tick “Allow object additions”)." });
  if (er.scope === "global" && !er.global_authorized) issues.push({ severity: "warn", code: "global_unauthorized", message: "Whole-image edit: nothing is protected by compositing." });
  if (er.scope === "local" && !er.edit_mask_id) issues.push({ severity: "warn", code: "mask_missing", message: "No edit area marked: the whole image will be sent and nothing is protected by compositing." });
  if (!text.trim()) issues.push({ severity: "block", code: "empty", message: "Describe the change you want." });
  if (cats.includes("lighting_adjustment") && er.scope === "local") issues.push({ severity: "warn", code: "lighting_local",
    message: "Lighting changes inside an area can leave a visible edge at its border. Review the boundary." });
  const finishes = new Map(s.records.filter((r) => r.record_type === "finish" && r.status !== "rejected").map((r) => [r.key.toUpperCase(), r]));
  const mentioned = [...new Set((text.match(/\b[A-Z]{1,4}-?\d{1,3}[A-Z]?\b/g) || []).map((m) => m.toUpperCase()))].sort();
  const refs: any[] = [];
  for (const code of mentioned) {
    const rec = finishes.get(code) || finishes.get(code.replace("-", ""));
    if (!rec) { issues.push({ severity: "warn", code: "finish_unknown", message: `Finish code ${code} is not in this project's finish records.` }); refs.push({ code, status: "unknown" }); }
    else if (rec.status !== "approved") {
      issues.push({ severity: "warn", code: "finish_unapproved", message: `Finish ${code} exists but has not been approved yet. Review it in Finish Schedule Intelligence.` });
      refs.push({ code, status: rec.status, record_id: rec.id });
    } else refs.push({ code, status: "approved", record_id: rec.id, data: rec.data, source: rec.source_ref, origin: rec.origin });
  }
  if (cats.includes("material_correction") && !mentioned.length) issues.push({ severity: "warn", code: "finish_not_referenced",
    message: "A material change is requested without a finish code. Name the scheduled code (for example PL2) so the edit follows the finish schedule." });
  if (!cats.length) cats = ["unclassified"];
  const lessons = s.qa.filter((q) => q.is_lesson && q.active !== false).concat(s.rules.filter((r) => r.active !== false));
  const prompt = buildPrompt(er, refs, lessons);
  const requires = new Set(["N01", "N04", "N05"]);
  if (refs.length || cats.includes("material_correction")) requires.add("N02");
  if (cats.includes("equipment_presentation")) requires.add("N03");
  return { categories: cats, referenced_finishes: refs, issues, blocking: issues.some((i) => i.severity === "block"), prompt,
    lessons_applied: lessons.map((l) => ({ id: l.id, title: l.title, scope: l.scope || "global" })), requires_modules: [...requires].sort() };
}

function finishText(r: any) {
  const d = r.data || {};
  const extra = [String(d.category || "").replace(/_/g, " "), d.color_name, d.texture].filter(Boolean).join(", ");
  return `${r.code}: ${[d.manufacturer, d.product].filter(Boolean).join(" ").trim()}${extra ? ` (${extra})` : ""}`;
}

export function buildPrompt(er: any, refs: any[], lessons: any[]) {
  const L = ["Edit this architectural interior render. The image is the authoritative source; treat it as a photograph to retouch, not a scene to redesign."];
  L.push(er.scope === "local" ? `Change ONLY this area: ${er.area_description || "the area marked in the edit mask"}. Everything else must stay identical.`
    : "Global adjustment authorised. Keep all geometry, materials and objects identical; adjust only what is requested.");
  L.push(`Requested change: ${String(er.instruction).trim()}`);
  const ok = refs.filter((r) => r.status === "approved");
  if (ok.length) {
    L.push("Specified finishes (from the project finish schedule):");
    ok.forEach((r) => L.push(`- ${finishText(r)}`));
    L.push("Match the specified product's real colour and texture; keep the existing panel joints, edges and grain direction.");
  }
  L.push("Constraints:");
  GLOBAL_RULES.forEach((r) => L.push(`- ${r}`));
  if (!er.allow_object_additions) L.push("- Do not add any objects, decor, people or plants.");
  L.push("- Keep the exact same image size, framing and aspect ratio.");
  if (lessons.length) { L.push("Project lessons:"); lessons.slice(0, 20).forEach((l) => L.push(`- ${l.title}`)); }
  return L.join("\n");
}
