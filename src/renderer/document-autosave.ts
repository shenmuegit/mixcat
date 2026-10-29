import { useEffect, useRef, useState } from 'react';

interface AutosaveEntry { id: string; fingerprint: string; }

// Both sources keep their own version checks and drafts; only scheduling is shared.
export function useDocumentAutosave(entries: AutosaveEntry[], blocked: boolean, save: (id: string) => Promise<boolean>) {
  const latest = useRef(save); latest.current = save;
  const running = useRef(false), failures = useRef(new Map<string, string>());
  const [savingId, setSavingId] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  const signature = JSON.stringify(entries);
  useEffect(() => {
    for (const id of failures.current.keys()) if (!entries.some(entry => entry.id === id)) failures.current.delete(id);
    if (blocked || running.current) return;
    const next = entries.find(entry => failures.current.get(entry.id) !== entry.fingerprint);
    if (!next) return;
    running.current = true; setSavingId(next.id);
    void (async () => {
      try {
        if (await latest.current(next.id)) failures.current.delete(next.id);
        else failures.current.set(next.id, next.fingerprint);
      } catch { failures.current.set(next.id, next.fingerprint); }
      finally { running.current = false; setSavingId(null); setAttempt(value => value + 1); }
    })();
  }, [signature, blocked, attempt]);
  return {
    savingId,
    failed: entries.some(entry => failures.current.get(entry.id) === entry.fingerprint),
    retry() { failures.current.clear(); setAttempt(value => value + 1); },
  };
}
