import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  listDownloadedSkins,
  downloadSkin as downloadSkinCmd,
  deleteDownloadedSkin as deleteCmd,
  getSkinsDirSize,
  clearAllSkins as clearAllCmd,
} from "../lib/commands";
import type { DownloadedSkin } from "../types";

import { createDownloadQueue, downloadKey, type DownloadItem } from "../lib/downloadQueue";

export function useDownloads() {
  const [downloads, setDownloads] = useState<DownloadedSkin[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cacheSize, setCacheSize] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const refreshGeneration = useRef(0);
  const [pendingKeys, setPendingKeys] = useState<string[]>([]);

  const refreshSize = useCallback(async () => {
    try {
      const size = await getSkinsDirSize();
      setCacheSize(size);
    } catch {
      // ignore
    }
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const list = await listDownloadedSkins();
      if (generation === refreshGeneration.current) setDownloads(list);
    } catch {}
    await refreshSize();
  }, [refreshSize]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const isDownloaded = useCallback(
    (championName: string, skinName: string): boolean => {
      return downloads.some((d) => d.champion_name === championName && d.skin_name === skinName);
    },
    [downloads]
  );

  const queue = useMemo(() => createDownloadQueue(
    (item) => downloadSkinCmd(item.url, item.championName, item.skinName),
    (active, pending, count) => {
      setActiveCount(count);
      setDownloading(active ? `${active.championName}/${active.skinName}` : null);
      setPendingKeys(pending);
    },
    setError,
    refresh,
  ), [refresh]);

  const downloadMultiple = useCallback((items: DownloadItem[]) => {
    setError(null);
    return queue.enqueue(items.filter((item) => !isDownloaded(item.championName, item.skinName)));
  }, [queue, isDownloaded]);

  const download = useCallback((url: string, championName: string, skinName: string) =>
    downloadMultiple([{ url, championName, skinName }]), [downloadMultiple]);

  const isQueued = useCallback((championName: string, skinName: string) =>
    pendingKeys.includes(downloadKey({ url: "", championName, skinName })), [pendingKeys]);

  const deleteSkin = useCallback(
    async (championName: string, skinName: string) => {
      setError(null);
      try {
        await deleteCmd(championName, skinName);
        await refresh();
      } catch (err) {
        setError(String(err));
      }
    },
    [refresh]
  );

  const clearAll = useCallback(async () => {
    setError(null);
    try {
      await clearAllCmd();
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }, [refresh]);

  const clearError = useCallback(() => setError(null), []);

  return {
    downloads,
    downloading,
    isQueued,
    pendingCount: pendingKeys.length,
    activeCount,
    error,
    cacheSize,
    isDownloaded,
    download,
    downloadMultiple,
    deleteSkin,
    clearAll,
    clearError,
    refresh,
  };
}
