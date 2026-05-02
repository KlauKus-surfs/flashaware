import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from 'react';
import { Box, MenuItem, Select, FormControl, Typography } from '@mui/material';
import BusinessIcon from '@mui/icons-material/Business';
import { getOrganisations } from './api';
import { useCurrentUser } from './App';
import InfoTip from './components/InfoTip';
import { helpBody, helpTitle } from './help/copy';

// Tenant-scope picker for super_admin. When the picker is set to a specific
// org UUID, every list view in the app filters to that org and "Add Location"
// creates inside it. When set to null ("All organisations"), super_admin sees
// the cross-org aggregate and create defaults to FlashAware.
//
// For non-super users this context is a no-op: scopedOrgId is always null and
// orgs is always empty. The server is the source of truth for the security
// boundary — it rejects org_id from non-super callers regardless of UI state.

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  user_count?: number;
  location_count?: number;
}

interface OrgScopeValue {
  scopedOrgId: string | null;
  setScopedOrgId: (id: string | null) => void;
  orgs: OrgSummary[];
  scopedOrgName: string | null;
  refreshOrgs: () => Promise<void>;
}

const OrgScopeContext = createContext<OrgScopeValue>({
  scopedOrgId: null,
  setScopedOrgId: () => {},
  orgs: [],
  scopedOrgName: null,
  refreshOrgs: async () => {},
});

export function useOrgScope() {
  return useContext(OrgScopeContext);
}

// Exported so login/logout in App.tsx can clear scope when the user identity
// changes — otherwise a previous super_admin's scope leaks into the next session.
export const SCOPED_ORG_STORAGE_KEY = 'flashaware_scoped_org_id';

export function OrgScopeProvider({ children }: { children: ReactNode }) {
  const user = useCurrentUser();
  const isSuper = user?.role === 'super_admin';

  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [scopedOrgId, setScopedOrgIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(SCOPED_ORG_STORAGE_KEY);
  });

  const setScopedOrgId = useCallback((id: string | null) => {
    setScopedOrgIdState(id);
    if (id) localStorage.setItem(SCOPED_ORG_STORAGE_KEY, id);
    else localStorage.removeItem(SCOPED_ORG_STORAGE_KEY);
  }, []);

  const refreshOrgs = useCallback(async () => {
    if (!isSuper) return;
    try {
      const res = await getOrganisations();
      setOrgs(res.data || []);
    } catch (err) {
      // 403 / network failure — leave list empty; picker will collapse.
      console.error('Failed to load organisations for scope picker', err);
      setOrgs([]);
    }
  }, [isSuper]);

  useEffect(() => {
    if (!isSuper) {
      setOrgs([]);
      // Clear any stale scope a previous super_admin left behind.
      if (scopedOrgId) setScopedOrgId(null);
      return;
    }
    refreshOrgs();
  }, [isSuper, refreshOrgs]); // eslint-disable-line react-hooks/exhaustive-deps

  // If the scoped org disappears from the list (deleted), drop the scope.
  useEffect(() => {
    if (!scopedOrgId || !isSuper) return;
    if (orgs.length === 0) return;
    if (!orgs.some((o) => o.id === scopedOrgId)) {
      setScopedOrgId(null);
    }
  }, [orgs, scopedOrgId, isSuper, setScopedOrgId]);

  const scopedOrgName = scopedOrgId ? (orgs.find((o) => o.id === scopedOrgId)?.name ?? null) : null;

  return (
    <OrgScopeContext.Provider
      value={{ scopedOrgId, setScopedOrgId, orgs, scopedOrgName, refreshOrgs }}
    >
      {children}
    </OrgScopeContext.Provider>
  );
}

export function OrgPicker() {
  const user = useCurrentUser();
  const { scopedOrgId, setScopedOrgId, orgs } = useOrgScope();

  if (user?.role !== 'super_admin') return null;
  if (orgs.length === 0) return null;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mr: 1 }}>
      <BusinessIcon
        sx={{ fontSize: 18, color: 'text.secondary', display: { xs: 'none', sm: 'inline' } }}
      />
      <Typography
        variant="caption"
        sx={{ color: 'text.secondary', display: { xs: 'none', md: 'inline' } }}
      >
        Acting as
      </Typography>
      <FormControl size="small" sx={{ minWidth: { xs: 130, sm: 180 } }}>
        <Select
          value={scopedOrgId ?? '__all__'}
          onChange={(e) =>
            setScopedOrgId(e.target.value === '__all__' ? null : (e.target.value as string))
          }
          sx={{ fontSize: 13, '& .MuiSelect-select': { py: 0.5 } }}
        >
          <MenuItem value="__all__">
            <em>All organisations</em>
          </MenuItem>
          {orgs.map((o) => (
            <MenuItem key={o.id} value={o.id}>
              {o.name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <InfoTip
        variant="dialog"
        title={helpTitle('org_scope')}
        body={helpBody('org_scope')}
        ariaLabel="What does scope mean?"
      />
    </Box>
  );
}
