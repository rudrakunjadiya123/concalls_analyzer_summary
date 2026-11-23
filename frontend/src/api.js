import { useEffect, useState } from "react";

/** Read only the same-origin public API and preserve its safe error message. */
export async function readApi(path, signal) {
  const response = await fetch(`/api${path}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(payload.error?.message ?? "The request failed");
  return payload;
}

/** Keep existing page content visible during background refreshes and cancel stale requests. */
export function useApi(path, revision = 0) {
  const [result, setResult] = useState(null);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    readApi(path, controller.signal)
      .then((payload) => setResult({ path, payload, error: null }))
      .catch((error) => {
        if (!controller.signal.aborted)
          setResult((previous) => ({
            path,
            payload: previous?.path === path ? previous.payload : null,
            error: error.message,
          }));
      });
    return () => controller.abort();
  }, [path, revision, attempt]);
  const selected = result?.path === path ? result : null;
  return {
    data: selected?.payload?.data,
    pagination: selected?.payload?.pagination,
    error: selected?.error,
    loading: !selected,
    retry: () => retry((value) => value + 1),
  };
}

export function apiPath(path, values) {
  const query = new URLSearchParams(
    Object.entries(values).filter(
      ([, value]) => value !== null && value !== undefined && value !== "",
    ),
  );
  return query.size ? `${path}?${query}` : path;
}
