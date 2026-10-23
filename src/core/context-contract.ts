import type { PersonaSnapshot } from "../persona/store.js";

/** Local context owned by Gateway, independent of optional external services. */
export interface LocalCoreSnapshot {
  core: string;
  recent: string;
  guidance: string;
  coreRevision: string;
  recentRevision: string;
  persona?: PersonaSnapshot;
  personaRevision?: string;
}
export interface LocalContextSnapshot {
  available: boolean;
  loadedAt: string;
  data?: LocalCoreSnapshot;
  error?: string;
  retryAfterMs?: number;
}
