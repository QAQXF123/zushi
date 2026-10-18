import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  matchId,
  matchTimestamp,
  mergeMatch,
  type Json,
  type CachedHistory,
} from "../lib/matchHistory";
import { playerKey, readCache, writeCache, flushCache } from "../lib/historyArchive";
import type { ClientAccount } from "./useLeagueClient";
interface Batch {
  games: Json[];
  start: number;
  count: number;
  source: string;
  notice: string | null;
}
const empty = (): CachedHistory => ({ games: [], fetchedAt: 0, cursors: {} });
export function useMatchHistory(
  player: ClientAccount | null,
  useSgp: boolean,
  online: boolean,
  ready: boolean
) {
  const key = player ? playerKey(player) : "",
    provider = useSgp ? "SGP" : "LCU";
  const [data, setData] = useState<CachedHistory>(empty);
  const dataRef = useRef(data),
    generation = useRef(0),
    busy = useRef(false);
  const [loading, setLoading] = useState(false),
    [hydratedKey, setHydratedKey] = useState("");
  const [error, setError] = useState<string | null>(null),
    [targetCount, setTargetCount] = useState(100);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const load = useCallback(
    async (limit: number, refresh = false) => {
      if (!player?.platform || !online || !ready || busy.current) return;
      const gen = generation.current;
      busy.current = true;
      setLoading(true);
      setError(null);
      setTargetCount(limit);
      let current = dataRef.current;
      const originalIds = new Set(current.games.map(matchId));
      const seenThisLoad = new Set<string>();
      const previous = current.cursors[provider] ?? { offset: 0, exhausted: false };
      let cursor = refresh ? 0 : previous.offset,
        newCount = 0,
        actualSource = "";
      try {
        while (cursor < Math.min(limit, 500)) {
          if (!refresh && previous.exhausted) break;
          const count = Math.min(20, limit - cursor, 500 - cursor);
          const batch = await invoke<Batch>("get_client_match_history", {
            puuid: player.puuid,
            start: cursor,
            count,
            useSgp,
            platform: player.platform,
          });
          if (gen !== generation.current) return;
          if (actualSource && batch.source !== actualSource)
            throw new Error("战绩数据源发生变化，已保留记录；请重新刷新后继续。");
          actualSource = batch.source;
          const seen = new Set(current.games.map(matchId));
          const valid = batch.games.filter((g) => Number(g.gameId) > 0);
          const additions = valid.filter((g) => !seen.has(matchId(g)) && !!seen.add(matchId(g)));
          const overlap = refresh && valid.some((g) => originalIds.has(matchId(g)));
          if (valid.length && valid.every((g) => seenThisLoad.has(matchId(g))))
            throw new Error("接口重复返回已有记录，已停止请求；可刷新后重试。");
          for (const game of valid) seenThisLoad.add(matchId(game));
          newCount += additions.length;
          cursor += batch.count;
          const merged = new Map(current.games.map((g) => [matchId(g), g]));
          for (const g of valid) merged.set(matchId(g), mergeMatch(merged.get(matchId(g)), g));
          const exhausted = batch.count < count;
          const sourcePrevious = current.cursors[batch.source] ?? { offset: 0, exhausted: false };
          const nextCursor =
            refresh && overlap
              ? {
                  offset: Math.min(500, Math.max(cursor, sourcePrevious.offset + newCount)),
                  exhausted: sourcePrevious.exhausted,
                }
              : { offset: cursor, exhausted };
          // A fallback uses its own cursor. Never reuse a LCU offset for SGP.
          current = {
            games: [...merged.values()].sort((a, b) => matchTimestamp(b) - matchTimestamp(a)),
            fetchedAt: Date.now(),
            source: batch.source,
            notice: batch.notice,
            cursors: { ...current.cursors, [batch.source]: nextCursor },
          };
          dataRef.current = current;
          setData(current);
          try {
            await writeCache("history", key, current);
            if (gen === generation.current) setCacheError(null);
          } catch (e) {
            if (gen === generation.current)
              setCacheError(`本地保存失败，当前记录仍可浏览：${String(e)}`);
            throw e;
          }
          if (gen !== generation.current) return;
          if (overlap || exhausted || batch.source !== provider) break;
        }
      } catch (e) {
        if (gen === generation.current)
          setError(`更新未完成，已保留 ${current.games.length} 场：${String(e)}`);
      } finally {
        if (gen === generation.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [key, player?.puuid, player?.platform, provider, online, ready, useSgp]
  );
  useEffect(() => {
    const gen = ++generation.current;
    busy.current = false;
    setLoading(false);
    setHydratedKey("");
    setError(null);
    setCacheError(null);
    dataRef.current = empty();
    setData(empty());
    if (!key) {
      setHydratedKey(key);
      return;
    }
    void readCache<CachedHistory>("history", key)
      .then((cached) => {
        if (gen !== generation.current) return;
        const next = cached ?? empty();
        dataRef.current = next;
        setData(next);
        setHydratedKey(key);
      })
      .catch((e) => {
        if (gen === generation.current) {
          setCacheError(`本地缓存无法读取，原文件已保留：${String(e)}`);
          setHydratedKey(key);
        }
      });
    return () => {
      generation.current++;
    };
  }, [key]);
  // Switching source/connectivity invalidates old requests, but preserves the archive.
  useEffect(() => {
    if (busy.current) {
      generation.current++;
      busy.current = false;
      setLoading(false);
    }
  }, [provider, online, ready]);
  useEffect(() => {
    if (
      hydratedKey === key &&
      !!key &&
      online &&
      ready &&
      (!dataRef.current.cursors[provider] ||
        (!dataRef.current.cursors[provider]?.exhausted &&
          dataRef.current.cursors[provider].offset < 100) ||
        !dataRef.current.fetchedAt ||
        Date.now() - dataRef.current.fetchedAt > 180_000)
    )
      void load(100, dataRef.current.games.length >= 100 || !dataRef.current.fetchedAt);
  }, [hydratedKey, key, online, ready, load]);
  useEffect(() => {
    if (!online || !ready || hydratedKey !== key || !key) return;
    const timer = setInterval(() => {
      if (!busy.current && Date.now() - dataRef.current.fetchedAt > 180_000) void load(100, true);
    }, 60_000);
    return () => clearInterval(timer);
  }, [key, hydratedKey, online, ready, load]);
  const cursor = data.cursors[provider] ?? { offset: 0, exhausted: false };
  const refresh = useCallback(() => load(100, true), [load]);
  const loadMore = () => load(Math.min(500, Math.floor(cursor.offset / 100) * 100 + 100));
  const loadAll = () => load(500);
  const cancel = () => {
    generation.current++;
    busy.current = false;
    setLoading(false);
  };
  const enrich = async (details: Json[]) => {
    const gen = generation.current;
    let changed = false;
    const map = new Map(details.map((g) => [matchId(g), g]));
    const games = dataRef.current.games.map((g) => {
      const full = map.get(matchId(g));
      if (full && (full.participants?.length ?? 0) > (g.participants?.length ?? 0)) {
        changed = true;
        return mergeMatch(g, full);
      }
      return g;
    });
    if (!changed) return;
    const next = { ...dataRef.current, games };
    dataRef.current = next;
    setData(next);
    try {
      await writeCache("history", key, next);
    } catch (e) {
      if (gen === generation.current) setCacheError(String(e));
    }
  };
  const clear = async () => {
    cancel();
    await flushCache("history", key).catch(() => {});
    await invoke("clear_player_history_cache", { id: key });
    dataRef.current = empty();
    setData(empty());
  };
  return {
    ...data,
    loading,
    hydrated: !key || hydratedKey === key,
    error,
    cacheError,
    exhausted: cursor.exhausted,
    limitReached: cursor.offset >= 500,
    targetCount,
    refresh,
    loadMore,
    loadAll,
    cancel,
    clear,
    enrich,
  };
}
