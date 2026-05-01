import { useContext } from 'react';
import { UserContext } from '../App';

// useAuth() — single source of truth for "what can the current user do?".
// Replaces scattered `user.role === 'admin' || user.role === 'super_admin'`
// checks across the app. Returns derived booleans plus the user object.
//
// If a screen renders without a user (shouldn't happen — App.tsx gates the
// main layout behind login), the hook returns the safest possible answer:
// `null` user, every capability false. Callers can treat the result as
// "permissions" without first null-checking.
export type Role = 'super_admin' | 'admin' | 'operator' | 'viewer';

export interface AuthInfo {
  user: { id: string; email: string; name: string; role: Role; org_id?: string; org_name?: string } | null;
  role: Role | null;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  isAdminOrAbove: boolean;
  isOperator: boolean;
  isOperatorOrAbove: boolean;
  isViewer: boolean;
  // Granular helpers — same checks the server enforces. Putting them here
  // means a UI bug (showing the Edit button for someone who'd get a 403) is a
  // single place to look at.
  canEditLocations: boolean;
  canEditUsers: boolean;
  canEditSettings: boolean;
  canManageOrgs: boolean;
  canViewAuditLog: boolean;
  canAcknowledgeAlerts: boolean;
}

export function useAuth(): AuthInfo {
  const user = useContext(UserContext) as AuthInfo['user'];
  const role = (user?.role ?? null) as Role | null;
  const isSuperAdmin = role === 'super_admin';
  const isAdmin = role === 'admin';
  const isAdminOrAbove = isSuperAdmin || isAdmin;
  const isOperator = role === 'operator';
  const isOperatorOrAbove = isAdminOrAbove || isOperator;
  const isViewer = role === 'viewer';

  return {
    user,
    role,
    isSuperAdmin,
    isAdmin,
    isAdminOrAbove,
    isOperator,
    isOperatorOrAbove,
    isViewer,
    // Mirror server requireRole levels so client/server stay in lockstep.
    canEditLocations: isAdminOrAbove,
    canEditUsers: isAdmin, // super_admin uses /orgs not /users; flag stays false for super
    canEditSettings: isAdminOrAbove,
    canManageOrgs: isSuperAdmin,
    canViewAuditLog: isAdminOrAbove,
    canAcknowledgeAlerts: isOperatorOrAbove,
  };
}
