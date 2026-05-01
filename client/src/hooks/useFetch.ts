import { useCallback, useEffect, useRef, useState } from 'react';
import { AxiosError, AxiosResponse } from 'axios';

// Hand-rolled fetch hook. Returns { data, loading, error, refetch } and
// cancels the in-flight call if the component unmounts or `deps` change.
//
// Why hand-rolled rather than react-query / swr: keeping the dep tree thin
// is a project value (we already have axios, MUI, leaflet, socket.io-client
// — none of them small). 30 lines covers the 95% case for this app.
//
// Usage:
//   const { data, loading, error, refetch } = useFetch(
//     () => getLocations(scopedOrgId), [scopedOrgId]
//   );
export interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useFetch<T>(
  fetcher: () => Promise<AxiosResponse<T> | T>,
  deps: ReadonlyArray<unknown> = [],
): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mounted ref so we don't setState on an unmounted component if the request
  // resolves after the user navigates away.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // tick increments on refetch() to retrigger the effect.
  const [tick, setTick] = useState(0);
  const refetch = useCallback(() => setTick(t => t + 1), []);

  // We intentionally roll deps + tick into the dep list manually so callers
  // can pass any shape they like. Disable exhaustive-deps for this effect —
  // the hook's contract IS that it re-runs when deps change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.resolve(fetcher())
      .then((res) => {
        if (cancelled || !mounted.current) return;
        // Accept both `axios.get(...)` style (returns AxiosResponse) and
        // already-unwrapped data — easier on callers that already have a
        // wrapper that returns the body.
        const body = (res && typeof res === 'object' && 'data' in res)
          ? (res as AxiosResponse<T>).data
          : (res as T);
        setData(body);
      })
      .catch((err: unknown) => {
        if (cancelled || !mounted.current) return;
        const ax = err as AxiosError<{ error?: string }>;
        setError(ax?.response?.data?.error || (err as Error)?.message || 'Request failed');
      })
      .finally(() => {
        if (cancelled || !mounted.current) return;
        setLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, loading, error, refetch };
}
