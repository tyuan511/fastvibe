import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageConfig, ImagesApi, ImageSession, ImageTask } from "@shared/image-generation";
import { cleanError } from "@/lib/ipc-error";

/** Read after subscribing; coalesce invalidations and reject late snapshots from another session. */
export function useImageWorkbench(api: ImagesApi) {
  const [sessions, setSessions] = useState<ImageSession[]>([]);
  const [tasks, setTasks] = useState<ImageTask[]>([]);
  const [config, setConfig] = useState<ImageConfig>({ models: [] });
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [loadedSessionId, setLoadedSessionId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const selectionEpoch = useRef(0);
  const selectedRef = useRef<string | undefined>(undefined);
  /** The session whose snapshot is on screen; only it makes a same-id click a no-op. */
  const loadedRef = useRef<string | undefined>(undefined);
  const liveRef = useRef(false);
  const requestedRevision = useRef(0);
  const appliedRevision = useRef(-1);
  const reading = useRef(false);
  const dirty = useRef(false);
  const configEpoch = useRef(0);
  const selectionWasChosen = useRef(false);

  const refreshConfig = useCallback(async () => {
    const epoch = ++configEpoch.current;
    setConfigLoading(true);
    setConfigError(null);
    try {
      const next = await api.getConfig();
      if (liveRef.current && configEpoch.current === epoch) setConfig(next);
    } catch (cause) {
      if (liveRef.current && configEpoch.current === epoch) setConfigError(cleanError(cause));
    } finally {
      if (liveRef.current && configEpoch.current === epoch) setConfigLoading(false);
    }
  }, [api]);

  const refresh = useCallback(async () => {
    dirty.current = true;
    if (reading.current) return;
    reading.current = true;
    try {
      while (dirty.current && liveRef.current) {
        dirty.current = false;
        const id = selectedRef.current;
        const epoch = selectionEpoch.current;
        try {
          const snapshot = await api.snapshot(id);
          if (!liveRef.current) return;
          if (epoch !== selectionEpoch.current || id !== selectedRef.current) { dirty.current = true; continue; }
          if (snapshot.revision < requestedRevision.current || snapshot.revision < appliedRevision.current) {
            // An invalidation arriving during this read has already marked a fresh read dirty.
            continue;
          }
          appliedRevision.current = snapshot.revision;
          setSessions(snapshot.sessions);
          setTasks(snapshot.tasks.filter((task) => task.sessionId === id).toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)));
          setLoadedSessionId(id);
          loadedRef.current = id;
          setError(null);
          setLoading(false);
          if (!selectionWasChosen.current) {
            selectionWasChosen.current = true;
            if (!id && snapshot.sessions.length) {
              selectionEpoch.current += 1;
              selectedRef.current = snapshot.sessions[0].id;
              setSelectedId(snapshot.sessions[0].id);
              dirty.current = true;
            }
          } else if (id && !snapshot.sessions.some((session) => session.id === id)) {
            // The selected session was deleted elsewhere: fall to the newest remaining
            // session, or to the draft view when none is left (the default-session
            // logic then creates one).
            selectionEpoch.current += 1;
            const next = snapshot.sessions[0];
            selectedRef.current = next?.id;
            setSelectedId(next?.id);
            setTasks([]);
            setLoadedSessionId(undefined);
            loadedRef.current = undefined;
            if (next) { dirty.current = true; continue; }
          }
        } catch (cause) {
          if (liveRef.current && epoch === selectionEpoch.current && id === selectedRef.current) { setError(cleanError(cause)); setLoading(false); }
        }
      }
    } finally { reading.current = false; }
  }, [api]);

  const selectSession = useCallback((id: string | undefined) => {
    // The session already on screen keeps its content: re-reading it would flash the
    // loading state and wipe the rows for a click that changes nothing. A selection
    // that has not loaded yet (mid-read, or the last read failed) still falls through,
    // which doubles as a retry for the error row's session.
    if (id === selectedRef.current && loadedRef.current === id) return;
    selectionWasChosen.current = true;
    selectionEpoch.current += 1;
    selectedRef.current = id;
    setSelectedId(id);
    setTasks([]);
    setLoadedSessionId(undefined);
    loadedRef.current = undefined;
    setLoading(true);
    setError(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    liveRef.current = true;
    const unsubscribe = api.onChanged((event) => {
      requestedRevision.current = Math.max(requestedRevision.current, event.revision);
      void refresh();
      void refreshConfig();
    });
    void refresh();
    void refreshConfig();
    return () => { liveRef.current = false; configEpoch.current++; unsubscribe(); };
  }, [api, refresh, refreshConfig]);
  useEffect(() => { void refresh(); }, [selectedId, refresh]);

  return { sessions, tasks, config, configLoading, configError, selectedId, loadedSessionId, selectSession, loading, error, refresh, refreshConfig };
}
