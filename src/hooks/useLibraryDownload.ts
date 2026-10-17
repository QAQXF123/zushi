import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { reloadLocalSkinLibrary } from "./useSkinData";

export interface LibraryProgress {
  phase: string; receivedBytes: number; totalBytes: number | null;
  current: number; total: number; imported: number; skipped: number; error: string | null;
}
const idle: LibraryProgress = { phase: "idle", receivedBytes: 0, totalBytes: null, current: 0, total: 0, imported: 0, skipped: 0, error: null };
export function useLibraryDownload(refresh: () => Promise<void>) {
  const [progress, setProgress] = useState(idle);
  const pending = useRef(false);
  const busy = ["downloading", "indexing", "importing", "cancelling"].includes(progress.phase);
  useEffect(() => { invoke<LibraryProgress>("get_library_progress").then(setProgress).catch(() => {}); }, []);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => invoke<LibraryProgress>("get_library_progress").then(setProgress).catch(() => {}), 500);
    return () => clearInterval(timer);
  }, [busy]);
  const start = useCallback(async () => {
    if (pending.current || busy) return;
    pending.current = true;
    setProgress({ ...idle, phase: "downloading" });
    try {
      setProgress(await invoke<LibraryProgress>("download_skin_library"));
    } catch (error) {
      const current = await invoke<LibraryProgress>("get_library_progress").catch(() => idle);
      setProgress(current.phase === "cancelled" ? current : { ...current, phase: "error", error: String(error) });
    } finally {
      await reloadLocalSkinLibrary().catch(() => {});
      await refresh();
      pending.current = false;
    }
  }, [busy, refresh]);
  const cancel = useCallback(async () => {
    await invoke("cancel_library_download");
    setProgress(p => ({ ...p, phase: "cancelling" }));
  }, []);
  return { progress, busy, start, cancel };
}
