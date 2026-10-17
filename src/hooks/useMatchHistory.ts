import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cachedHistory, saveHistory, matchId, matchTimestamp, type Json, type CachedHistory } from "../lib/matchHistory";
interface Batch { games: Json[]; start: number; count: number; source:string; notice:string|null; }
export function useMatchHistory(puuid: string | undefined, useSgp=false) {
  const cacheId=(id:string)=>`${useSgp?"SGP":"LCU"}:${id}`;
  const [source,setSource]=useState("");
  const [notice,setNotice]=useState<string|null>(null);
  const [games, setGames] = useState<Json[]>([]);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetCount, setTargetCount] = useState(100);
  const generation = useRef(0);
  const load = useCallback(async (id: string, limit: number, reset = false) => {
    const gen = ++generation.current;
    let data: CachedHistory = reset ? { games: [], offset: 0, exhausted: false, fetchedAt: 0 }
      : cachedHistory(cacheId(id)) ?? { games: [], offset: 0, exhausted: false, fetchedAt: 0 };
    setGames(data.games); setOffset(data.offset); setExhausted(data.exhausted); setLoading(true); setError(null); setTargetCount(limit);setSource(data.source??"");setNotice(data.notice??null);
    try {
      while (!data.exhausted && data.offset < Math.min(limit, 500)) {
        const count = Math.min(20, limit - data.offset, 500 - data.offset);
        const batch = await invoke<Batch>("get_client_match_history", { puuid: id, start: data.offset, count, useSgp });
        if (generation.current !== gen) return;
        const seen = new Set(data.games.map(matchId));
        const additions = batch.games.filter(game => Number(game.gameId)>0 && !seen.has(matchId(game)) && !!seen.add(matchId(game)));
        if(batch.games.length&&!additions.length)throw new Error("接口重复返回同一批战绩，已停止继续请求；已读取记录仍可查看。");
        data = { games: [...data.games, ...additions].sort((a,b) => matchTimestamp(b)-matchTimestamp(a)).slice(0,500),
          offset: Math.min(500, data.offset + batch.count), exhausted: batch.count < count || additions.length === 0, fetchedAt: Date.now(),source:batch.source,notice:batch.notice };
        saveHistory(cacheId(id), data); setGames(data.games); setOffset(data.offset); setExhausted(data.exhausted);setSource(batch.source);setNotice(batch.notice);
      }
    } catch (e) {
      if (generation.current === gen) setError(data.games.length ? `已保留 ${data.games.length} 场，更多记录暂时无法读取：${String(e)}` : String(e));
    } finally {
      if (generation.current === gen) setLoading(false);
    }
  }, [useSgp]);
  useEffect(() => {
    generation.current++;
    if (!puuid) { setGames([]); setOffset(0); setLoading(false); setExhausted(false); setError(null); return; }
    const cached = cachedHistory(cacheId(puuid));
    if (cached) { setSource(cached.source??"");setNotice(cached.notice??null);setGames(cached.games); setOffset(cached.offset); setExhausted(cached.exhausted); setLoading(false); setError(null); }
    else void load(puuid, 100);
    return () => { generation.current++; };
  }, [puuid, load, useSgp]);
  const refresh = useCallback(() => puuid && load(puuid, 100, true), [puuid, load, useSgp]);
  const loadMore = useCallback(() => puuid && load(puuid, Math.min(500, Math.ceil((cachedHistory(cacheId(puuid))?.offset ?? 0) / 100) * 100 + 100)), [puuid, load, useSgp]);
  const loadAll = useCallback(() => puuid && load(puuid, 500), [puuid, load, useSgp]);
  const cancel = useCallback(() => { generation.current++; setLoading(false); }, []);
  return { source,notice,games, loading, exhausted, limitReached: offset >= 500, error, targetCount, refresh, loadMore, loadAll, cancel };
}
