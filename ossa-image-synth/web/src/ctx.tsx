import { createContext, useContext } from "react";
import type { ModuleInfo, ModuleKey, Project, User } from "./types";

export interface Ctx {
  user: User;
  project: Project;
  modules: Record<ModuleKey, ModuleInfo> | null;
  refresh: () => Promise<void>;
  reloadProject: () => Promise<void>;
  toast: (msg: string, kind?: "ok" | "err" | "info") => void;
  open: (k: ModuleKey) => void;
  canEdit: boolean;
  canReview: boolean;
  tick: number;
}
export const ProjectCtx = createContext<Ctx | null>(null);
export const useP = () => {
  const c = useContext(ProjectCtx);
  if (!c) throw new Error("no project context");
  return c;
};
