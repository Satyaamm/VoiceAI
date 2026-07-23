'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Minimal fetch-on-mount hook. Deliberately small: server-state caching is
 * TanStack Query's job (docs/07) and gets introduced when the API is live —
 * this keeps screens honest about loading and error states until then.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const latest = useRef(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const run = ++latest.current;
    setLoading(true);
    setError(null);
    fn()
      .then((value) => {
        if (run === latest.current) setData(value);
      })
      .catch((err: Error) => {
        if (run === latest.current) setError(err.message);
      })
      .finally(() => {
        if (run === latest.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload };
}
