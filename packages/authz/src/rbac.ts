/** RBAC matrix (§11.10). Deny by default. */
export const ROLES = ["owner", "admin", "developer", "approver", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "actions:read", "actions:write", "actions:raw_request",
  "approvals:decide", "undo:request", "undo:force",
  "policies:read", "policies:write",
  "connections:read", "credentials:manage",
  "keys:manage", "members:manage", "security:settings", "billing:manage", "usage:read",
  "upstreams:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEW: Permission[] = ["actions:read", "policies:read", "connections:read", "usage:read"];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  owner: new Set(PERMISSIONS),
  admin: new Set(PERMISSIONS.filter((p) => p !== "billing:manage")),
  developer: new Set<Permission>([...VIEW, "actions:write", "undo:request", "policies:write", "credentials:manage", "upstreams:manage"]),
  approver: new Set<Permission>([...VIEW, "approvals:decide", "undo:request"]),
  viewer: new Set<Permission>(VIEW),
};

export function roleCan(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(perm) ?? false;
}
