import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fromSearch, toSearch, type QueryState } from './query';

/** Range, interval and filters live in the URL (toSearch/fromSearch); changes replace the history entry's query. */
export function useQueryState(): [QueryState, (p: Partial<QueryState>) => void] {
  const [params, setParams] = useSearchParams();
  const q = useMemo(() => fromSearch(params.toString()), [params]);
  const update = useCallback(
    (p: Partial<QueryState>) => setParams(toSearch({ ...q, ...p }), { replace: true }),
    [q, setParams],
  );
  return [q, update];
}
