export type ModuleState = "EMPTY" | "PROCESSING" | "NEEDS_REVIEW" | "VALIDATED" | "ERROR";
export type ModuleKey = "N01" | "N02" | "N03" | "N04" | "N05" | "N06" | "N07" | "N08" | "N09";

export interface Requirement {
  id: string;
  label: string;
  satisfied: boolean;
  required: boolean;
  detail: string;
}
export interface ModuleInfo {
  key: ModuleKey;
  name: string;
  inputs: string;
  critical: boolean | "conditional";
  state: ModuleState;
  readiness: "satisfied" | "partial" | "blocked";
  requirements: Requirement[];
  missing: string[];
  sources: { document_id: string; name: string; mapping: string; status: string }[];
  counts?: Record<string, number>;
  mode?: string;
  last_job_error?: string;
  edit_request_id?: string | null;
}
export interface Project {
  id: string;
  name: string;
  code: string;
  description: string;
  budget_usd: number;
  spent_usd: number;
  canvas: any;
  oscillator: any;
  is_reference: boolean;
  role: string;
}
export interface User {
  id: string;
  email: string;
  name: string;
  is_admin: boolean;
}
export interface Rec {
  id: string;
  module_key: string;
  record_type: string;
  key: string;
  data: Record<string, any>;
  status: "proposed" | "approved" | "rejected";
  origin: string;
  document_id: string | null;
  document_name?: string;
  source_ref: string;
  evidence: string;
  confidence: number;
  notes: string;
}
export interface Mask {
  id: string;
  kind: "edit" | "protected";
  label: string;
  coverage: number;
  status: string;
  source_image_id: string;
}
export interface SourceImage {
  id: string;
  label: string;
  width: number;
  height: number;
  sha256: string;
  status: string;
  document_id: string;
  masks: Mask[];
}

export const STATE_LABEL: Record<ModuleState, string> = {
  EMPTY: "EMPTY",
  PROCESSING: "PROCESSING",
  NEEDS_REVIEW: "NEEDS REVIEW",
  VALIDATED: "VALIDATED",
  ERROR: "ERROR",
};
