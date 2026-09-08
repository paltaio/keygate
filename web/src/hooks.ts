import { useEffect, useEffectEvent, useState } from "react";
import { errorMessage } from "./format.ts";

interface Settled<T> {
  stamp: string;
  data: T | null;
  error: string | null;
  at: number;
}

export interface Load<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** When the data was fetched; use it as "now" for relative times. */
  at: number;
  reload: () => void;
}

/**
 * Fetches once per `key` and on reload. Data for the same key stays visible
 * while a reload is in flight; a new key starts from empty.
 */
export function useLoad<T>(key: string, fn: () => Promise<T>): Load<T> {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [version, setVersion] = useState(0);
  const stamp = `${key}#${version}`;
  const run = useEffectEvent(fn);

  useEffect(() => {
    let live = true;
    run().then(
      (data) => {
        if (live) setSettled({ stamp, data, error: null, at: Date.now() });
      },
      (e: unknown) => {
        if (live) setSettled({ stamp, data: null, error: errorMessage(e), at: Date.now() });
      },
    );
    return () => {
      live = false;
    };
  }, [stamp]);

  const sameKey = settled !== null && settled.stamp.startsWith(`${key}#`);
  const fresh = sameKey && settled.stamp === stamp;
  return {
    data: sameKey ? settled.data : null,
    error: fresh ? settled.error : null,
    loading: !fresh,
    at: sameKey ? settled.at : 0,
    reload: () => setVersion((v) => v + 1),
  };
}

export interface Action<A extends unknown[]> {
  run: (...args: A) => Promise<boolean>;
  busy: boolean;
  error: string | null;
  reset: () => void;
}

/** Wraps a mutation with busy and error state; run resolves true on success. */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<void>): Action<A> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    busy,
    error,
    reset: () => setError(null),
    run: async (...args: A) => {
      if (busy) return false;
      setBusy(true);
      setError(null);
      try {
        await fn(...args);
        return true;
      } catch (e) {
        setError(errorMessage(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
  };
}
