import React from 'react';
import { useAuth, AuthInfo, Role } from '../hooks/useAuth';

// <PermissionGate roles={['admin','super_admin']}>...</PermissionGate>
// or
// <PermissionGate when={(auth) => auth.canManageOrgs}>...</PermissionGate>
//
// Hides children unless the current user satisfies the predicate. A `fallback`
// prop is supported for cases where you want to render an explanatory note
// instead of nothing — most call sites just hide the affordance.
interface Props {
  children: React.ReactNode;
  roles?: Role[];
  when?: (auth: AuthInfo) => boolean;
  fallback?: React.ReactNode;
}

export function PermissionGate({ children, roles, when, fallback = null }: Props) {
  const auth = useAuth();
  const allowed = roles ? roles.includes(auth.role as Role) : when ? when(auth) : false; // require an explicit policy — refusing-by-default is safer than allowing-by-default
  return <>{allowed ? children : fallback}</>;
}
