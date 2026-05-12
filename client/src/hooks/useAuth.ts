import { useContext } from 'react';
import { UserContext } from '../App';

export type Role = 'super_admin' | 'representative' | 'admin' | 'operator' | 'viewer';

export interface AuthInfo {
  user: {
    id: string;
    email: string;
    name: string;
    role: Role;
    org_id?: string;
    org_name?: string;
  } | null;
  role: Role | null;
  isSuperAdmin: boolean;
  isRepresentative: boolean;
  isAdmin: boolean;
  isAdminOrAbove: boolean; // now true for super_admin OR representative OR admin
  isOperator: boolean;
  isOperatorOrAbove: boolean;
  isViewer: boolean;
  isPlatformWide: boolean; // mirrors server isPlatformWideUser
  canEditLocations: boolean;
  canEditUsers: boolean;
  canEditSettings: boolean;
  canManageOrgs: boolean;
  canViewAuditLog: boolean;
  canAcknowledgeAlerts: boolean;
  canViewPlatformOverview: boolean;
}

export function useAuth(): AuthInfo {
  const user = useContext(UserContext) as AuthInfo['user'];
  const role = (user?.role ?? null) as Role | null;

  const isSuperAdmin = role === 'super_admin';
  const isRepresentative = role === 'representative';
  const isAdmin = role === 'admin';
  // isAdminOrAbove now extends to representative — every per-org admin
  // capability gated on this flag (edit locations / users / settings / etc.)
  // automatically applies to representatives without per-flag rewrites.
  const isAdminOrAbove = isSuperAdmin || isRepresentative || isAdmin;
  const isOperator = role === 'operator';
  const isOperatorOrAbove = isAdminOrAbove || isOperator;
  const isViewer = role === 'viewer';
  const isPlatformWide = isSuperAdmin || isRepresentative;

  return {
    user,
    role,
    isSuperAdmin,
    isRepresentative,
    isAdmin,
    isAdminOrAbove,
    isOperator,
    isOperatorOrAbove,
    isViewer,
    isPlatformWide,
    canEditLocations: isAdminOrAbove,
    // canEditUsers stays admin+ — representative manages users via the
    // org-scoped management screen the same way an admin does. Promotion
    // TO representative or super_admin is super_admin-only and lives in
    // the platform overview, not the standard user-management screen.
    canEditUsers: isAdminOrAbove,
    canEditSettings: isAdminOrAbove,
    // canManageOrgs (create/delete org) stays super_admin-only — denial action A.
    canManageOrgs: isSuperAdmin,
    canViewAuditLog: isAdminOrAbove,
    canAcknowledgeAlerts: isOperatorOrAbove,
    // Representative can view the platform overview (read-only). Mutation
    // buttons on that page must check isSuperAdmin separately.
    canViewPlatformOverview: isPlatformWide,
  };
}
