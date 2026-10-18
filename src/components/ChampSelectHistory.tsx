import { localize } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { accountName, type ClientAccount } from "../hooks/useLeagueClient";
import { playerKey, playerProfile, readCache, writeCache } from "../lib/historyArchive";
import { aggregate, positions, validGames } from "../lib/matchAnalysis";
import {
  championInfo,
  matchParticipant,
  matchResult,
  matchId,
  mergeMatch,
  matchTimestamp,
  rankedQueues,
  rankName,
  type CachedHistory,
  type Json,
} from "../lib/matchHistory";
import { GameImage } from "./GameAssets";
interface Card {
  slot: number;
  championId: number;
  position: string;
  account?: ClientAccount;
  profile?: Json;
  games?: Json[];
  error?: string;
  loading?: boolean;
}
export default function ChampSelectHistory({
  phase,
  connected,
  platform,
  useSgp,
  onChoose,
}: {
  phase: string;
  connected: boolean;
  platform: string;
  useSgp: boolean;
  onChoose: (p: ClientAccount) => void;
}) {
  const [cards, setCards] = useState<Card[]>([]),
    [error, setError] = useState("");
  const results = useRef(new Map<string, Card>());
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    if (!connected || phase !== "ChampSelect") {
      setCards([]);
      results.current.clear();
      return;
    }
    const poll = async () => {
      try {
        const session = await invoke<{ players: Json[] }>("get_client_champ_select");
        if (disposed) return;
        const next: Card[] = session.players.map((p, index) => ({
          ...results.current.get(`${platform}:${p.puuid}`),
          slot: Number(p.cellId ?? index),
          championId: Number(p.championId) || 0,
          position: String(p.position ?? "").toUpperCase(),
          account:
            typeof p.puuid === "string" &&
            /^[a-zA-Z0-9_-]{10,200}$/.test(p.puuid) &&
            !/^0[-0]*$/.test(p.puuid)
              ? {
                  puuid: p.puuid,
                  platform,
                  summonerId: Number(p.summonerId) || 0,
                  gameName: "",
                  tagLine: "",
                  displayName: `玩家 ${String(p.puuid).slice(0, 6)}`,
                  profileIconId: 0,
                  level: 0,
                }
              : undefined,
        }));
        // Preserve the changing champion/position even when profile data is cached.
        for (const card of next) {
          const cached = card.account && results.current.get(playerKey(card.account));
          if (cached?.account) card.account = cached.account;
        }
        setCards(next);
        setError("");
        let cursor = 0;
        const worker = async () => {
          while (cursor < next.length && !disposed) {
            const i = cursor++,
              card = next[i];
            if (!card.account || !platform) continue;
            const key = playerKey(card.account);
            const existing = results.current.get(key);
            if (existing && !existing.error) {
              next[i] = {
                ...existing,
                slot: card.slot,
                championId: card.championId,
                position: card.position,
              };
              continue;
            }
            try {
              const [profileResult, cacheResult] = await Promise.allSettled([
                playerProfile(card.account, true),
                readCache<CachedHistory>("history", key),
              ]);
              if (disposed) return;
              const profile = profileResult.status === "fulfilled" ? profileResult.value : null;
              let archive = cacheResult.status === "fulfilled" ? cacheResult.value : null;
              let games = archive?.games ?? [],
                notice = "";
              if (!archive || Date.now() - archive.fetchedAt > 180_000) {
                try {
                  const batch = await invoke<{
                    games: Json[];
                    count: number;
                    source: string;
                    notice: string | null;
                  }>("get_client_match_history", {
                    puuid: card.account.puuid,
                    platform,
                    start: 0,
                    count: 20,
                    useSgp,
                  });
                  if (disposed) return;
                  const merged = new Map(games.map((g) => [matchId(g), g]));
                  for (const g of batch.games)
                    merged.set(matchId(g), mergeMatch(merged.get(matchId(g)), g));
                  games = [...merged.values()].sort(
                    (a, b) => matchTimestamp(b) - matchTimestamp(a)
                  );
                  archive = {
                    ...archive,
                    games,
                    fetchedAt: Date.now(),
                    source: batch.source,
                    notice: batch.notice,
                    cursors: archive?.cursors ?? {
                      [batch.source]: { offset: batch.count, exhausted: batch.count < 20 },
                    },
                  };
                  await writeCache("history", key, archive);
                } catch (e) {
                  notice = String(e);
                }
              }
              const value = {
                ...card,
                account: profile?.account ?? card.account,
                profile: profile ?? undefined,
                games,
                error:
                  notice ||
                  (!profile && profileResult.status === "rejected"
                    ? String(profileResult.reason)
                    : undefined),
              };
              results.current.set(key, value);
              next[i] = value;
            } catch (e) {
              next[i] = { ...card, error: String(e) };
            }
            if (!disposed) setCards([...next]);
          }
        };
        await Promise.all([worker(), worker()]);
        if (!disposed) setCards([...next]);
      } catch (e) {
        if (!disposed) setError(String(e));
      }
      if (!disposed) timer = setTimeout(poll, 8000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [phase, connected, platform, useSgp]);
  return (
    <div className="space-y-3 text-xs">
      <p className="text-ink-muted">
        {localize(
          "选人时自动读取可识别的队友，仅展示接口提供的信息；匿名玩家不会尝试识别。胜率基于已收录的近期有效对局。"
        )}
      </p>
      {localize(
        phase !== "ChampSelect" && (
          <div className="bg-charcoal-500 text-ink-muted rounded-lg p-10 text-center">
            {localize("进入选择英雄阶段后，这里会自动展示队友卡片。")}
          </div>
        )
      )}
      {localize(error && <p className="text-error">{localize(error)}</p>)}
      {localize(
        cards.map((c) => {
          const samples = validGames(c.games ?? [], c.account?.puuid ?? "").slice(0, 20),
            stats = aggregate(samples, c.account?.puuid ?? "");
          const rank = rankedQueues(c.profile?.ranked)[0];
          const champ = championInfo(c.championId);
          const heroSamples = validGames(c.games ?? [], c.account?.puuid ?? "").filter(
            (g) => Number(matchParticipant(g, c.account?.puuid ?? "")?.championId) === c.championId
          );
          const heroStats = aggregate(heroSamples, c.account?.puuid ?? "");
          return (
            <div key={c.slot} className="bg-charcoal-500 flex items-center gap-4 rounded-lg p-4">
              <GameImage
                path={
                  c.championId
                    ? `/lol-game-data/assets/v1/champion-icons/${c.championId}.png`
                    : undefined
                }
                title={localize(champ?.chineseName ?? "尚未选择英雄")}
                size={48}
              />
              <div className="min-w-0 flex-1">
                <button
                  disabled={!c.account}
                  onClick={() => c.account && onChoose(c.account)}
                  className="text-ink hover:text-gold-400 cursor-pointer font-medium disabled:cursor-default"
                >
                  {localize(c.account ? accountName(c.account) : "匿名 / 尚未提供玩家身份")}
                </button>
                <p className="text-ink-muted mt-2">
                  {localize(positions[c.position] ?? "位置待定")}
                  {localize(" · ")}
                  {localize(champ?.chineseName ?? "尚未选择英雄")}
                  {localize(" ·")}
                  {localize(" ")}
                  {localize(rank ? rankName(rank) : "段位暂不可用")}
                </p>
                {localize(c.error && <p className="text-ink-muted mt-2">{localize(c.error)}</p>)}
              </div>
              <div className="text-right">
                <p className="text-gold-400">
                  {localize(
                    samples.length ? `${stats.rate}% 胜率 · KDA ${stats.kda}` : "暂无可用统计"
                  )}
                </p>
                <p className="text-ink-muted mt-2">
                  {localize("样本 ")}
                  {localize(samples.length)}
                  {localize(" 场 · ")}
                  {localize(stats.wins)}
                  {localize(" 胜 ")}
                  {localize(stats.losses)}
                  {localize(" 负")}
                </p>
                <p className="text-ink-muted mt-2">
                  {localize("当前英雄 ")}
                  {localize(heroSamples.length)}
                  {localize(" 场 ·")}
                  {localize(" ")}
                  {localize(heroSamples.length ? `${heroStats.rate}% 胜率` : "暂无样本")}
                </p>
                <div className="mt-2 flex justify-end gap-1">
                  {localize(
                    samples
                      .slice(0, 10)
                      .map((g) => (
                        <span
                          key={String(g.gameId)}
                          title={localize(
                            matchResult(g, matchParticipant(g, c.account?.puuid ?? "")) === "win"
                              ? "胜利"
                              : "失败"
                          )}
                          className={`h-1.5 w-1.5 rounded-full ${matchResult(g, matchParticipant(g, c.account?.puuid ?? "")) === "win" ? "bg-emerald-400" : "bg-rose-400"}`}
                        />
                      ))
                  )}
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
