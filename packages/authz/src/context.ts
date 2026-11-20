import { RelayonError } from "@relayon/core";

export const KINDS = ["read", "create", "update", "delete", "send", "pay"] as const;
export type Kind = (typeof KINDS)[number];

/** Request-scoped tenant context. Built ONLY from the authenticated credential (§11.5). */
export interface ApiKeyPrincipal {
  type: "api_key";
  keyId: string;
  scopes: readonly string[];
  agentName: string | null;
  allowedApps: readonly string[] | null;
  allowedTools: readonly string[] | null;
  maxKind: Kind | null;
  allowedEndUsers: readonly string[] | null;
}

export interface TenantContext {
  orgId: string;
  projectId: string;
  principal: ApiKeyPrincipal;
}

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

export function matchesAny(value: string, globs: readonly string[] | null): boolean {
  if (globs === null) return true;
  return globs.some((g) => globToRegExp(g).test(value));
}

export function kindRank(k: string): number {
  const i = (KINDS as readonly string[]).indexOf(k);
  return i === -1 ? KINDS.length : i; // unknown/"other" ranks above everything
}

/**
 * Per-agent key scoping (§11.7). Throws RELAYON_FORBIDDEN when the key may not run this tool.
 */
export function assertToolAllowed(p: ApiKeyPrincipal, tool: { id: string; app: string; kind: string }, endUserExternalId?: string): void {
  if (!p.scopes.includes("actions:write")) throw new RelayonError("RELAYON_FORBIDDEN", "Key lacks actions:write");
  if (!matchesAny(tool.app, p.allowedApps)) throw new RelayonError("RELAYON_FORBIDDEN", `Key may not use app ${tool.app}`);
  if (!matchesAny(tool.id, p.allowedTools)) throw new RelayonError("RELAYON_FORBIDDEN", `Key may not use tool ${tool.id}`);
  if (p.maxKind && kindRank(tool.kind) > kindRank(p.maxKind)) {
    throw new RelayonError("RELAYON_FORBIDDEN", `Key max_kind ${p.maxKind} does not allow ${tool.kind}`);
  }
  if (p.allowedEndUsers && (!endUserExternalId || !matchesAny(endUserExternalId, p.allowedEndUsers))) {
    throw new RelayonError("RELAYON_FORBIDDEN", "Key may not act for this end user");
  }
}

export function assertScope(p: ApiKeyPrincipal, scope: string): void {
  if (!p.scopes.includes(scope)) throw new RelayonError("RELAYON_FORBIDDEN", `Key lacks ${scope}`);
}
