import { localize } from "../i18n";
import { useMemo, useState } from "react";
import {
  championInfo,
  matchParticipant,
  matchResult,
  number,
  matchTimestamp,
  type Json,
} from "../lib/matchHistory";
import {
  aggregate,
  positionOf,
  positions,
  recentDays,
  streak,
  validGames,
} from "../lib/matchAnalysis";
import { GameImage } from "./GameAssets";
export default function MatchAnalysis({
  games,
  puuid,
  tab,
  onHero,
}: {
  games: Json[];
  puuid: string;
  tab: "heroes" | "trends";
  onHero: (name: string) => void;
}) {
  const [sort, setSort] = useState("games"),
    [windowSize, setWindowSize] = useState(100),
    [heroQuery, setHeroQuery] = useState("");
  const pool = useMemo(() => validGames(games, puuid), [games, puuid]);
  const samples = pool.slice(0, windowSize),
    totals = aggregate(samples, puuid);
  const heroRows = useMemo(() => {
    const groups = new Map<number, Json[]>();
    for (const g of pool) {
      const id = number(matchParticipant(g, puuid)?.championId);
      groups.set(id, [...(groups.get(id) ?? []), g]);
    }
    return [...groups.entries()]
      .map(([id, list]) => ({ id, list, ...aggregate(list, puuid) }))
      .filter((h) =>
        `${championInfo(h.id)?.chineseName} ${championInfo(h.id)?.id}`
          .toLowerCase()
          .includes(heroQuery.toLowerCase())
      )
      .sort((a, b) =>
        sort === "rate"
          ? b.rate - a.rate || b.games - a.games
          : sort === "kda"
            ? Number(b.kda) - Number(a.kda)
            : sort === "recent"
              ? matchTimestamp(b.list[0]) - matchTimestamp(a.list[0])
              : b.games - a.games
      );
  }, [pool, puuid, sort, heroQuery]);
  return (
    <div className="space-y-4 text-xs">
      <p className="text-ink-muted">
        {localize("基于本地已收录的 ")}
        {localize(pool.length)}
        {localize(" ")}
        {localize("场有效对局统计；不含重开、人机、训练和自定义，不代表生涯总数据。")}
      </p>
      {localize(
        tab === "heroes" ? (
          <>
            <div className="flex gap-3">
              <input
                value={heroQuery}
                onChange={(e) => setHeroQuery(e.target.value)}
                placeholder={localize("搜索英雄中文名 / 英文名")}
                className="bg-charcoal-500 border-border flex-1 rounded border px-3 py-2"
              />
              <select
                aria-label={localize("英雄统计排序")}
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                className="bg-charcoal-500 rounded p-2"
              >
                <option value="games">{localize("场次最多")}</option>
                <option value="rate">{localize("胜率最高")}</option>
                <option value="kda">{localize("KDA 最高")}</option>
                <option value="recent">{localize("最近使用")}</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {localize(
                heroRows.map((h) => {
                  const champ = championInfo(h.id);
                  const distribution = new Map<string, number>();
                  for (const g of h.list) {
                    const pos = positionOf(matchParticipant(g, puuid));
                    if (pos !== "UNKNOWN") distribution.set(pos, (distribution.get(pos) ?? 0) + 1);
                  }
                  const pos = [...distribution].sort((a, b) => b[1] - a[1])[0]?.[0];
                  return (
                    <button
                      key={h.id}
                      onClick={() => onHero(champ?.chineseName ?? String(h.id))}
                      className="bg-charcoal-500 hover:bg-charcoal-300 flex cursor-pointer items-center gap-3 rounded-lg p-3 text-left"
                    >
                      <GameImage
                        path={`/lol-game-data/assets/v1/champion-icons/${h.id}.png`}
                        title={localize(champ?.chineseName ?? "英雄")}
                        size={44}
                      />
                      <div className="flex-1">
                        <p className="text-ink font-medium">
                          {localize(champ?.chineseName ?? h.id)}
                          {localize(" ")}
                          <span className="text-ink-muted font-normal">
                            {localize(pos ? positions[pos] : "")}
                          </span>
                        </p>
                        <p className="text-ink-muted mt-1">
                          {localize(h.games)}
                          {localize(" 场 · ")}
                          {localize(h.wins)}
                          {localize(" 胜 ")}
                          {localize(h.losses)}
                          {localize(" 负 · 胜率")}
                          {localize(" ")}
                          <span className="text-gold-400">
                            {localize(h.rate)}
                            {localize("%")}
                          </span>
                        </p>
                        <p className="text-ink-muted mt-1">
                          {localize("KDA ")}
                          {localize(h.kda)}
                          {localize(" · 场均伤害")}
                          {localize(" ")}
                          {localize(h.damage == null ? "—" : `${(h.damage / 1000).toFixed(1)}k`)}
                          {localize(" · 补刀 ")}
                          {localize(h.cs)}
                          {localize("/分")}
                        </p>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              {localize(
                [20, 50, 100].map((n) => (
                  <button
                    key={n}
                    onClick={() => setWindowSize(n)}
                    className={`cursor-pointer rounded px-3 py-2 ${n === windowSize ? "bg-gold-400 text-charcoal-600" : "bg-charcoal-500"}`}
                  >
                    {localize("最近 ")}
                    {localize(n)}
                    {localize(" 场")}
                  </button>
                ))
              )}
              <span className="text-ink-muted ml-auto">
                {localize("实际样本 ")}
                {localize(samples.length)}
                {localize(" 场")}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-3">
              {localize(
                [
                  ["胜率", `${totals.rate}%`],
                  ["平均 KDA", totals.kda],
                  ["当前走势", streak(pool, puuid)],
                  ["每分钟补刀", totals.cs],
                ].map(([label, value]) => (
                  <div key={label} className="bg-charcoal-500 rounded-lg p-4">
                    <p className="text-ink-muted">{localize(label)}</p>
                    <p className="text-gold-400 mt-2 text-xl">
                      {localize(samples.length ? value : "—")}
                    </p>
                  </div>
                ))
              )}
            </div>
            <div className="bg-charcoal-500 rounded-lg p-4">
              <p className="text-ink mb-4">
                {localize("最近对局走势")}
                {localize(" ")}
                <span className="text-ink-muted">
                  {localize("从左至右由旧到新，每条代表一场，柱高表示 KDA（最高按 10 绘制）")}
                </span>
              </p>
              <div className="flex h-28 items-end gap-1">
                {localize(
                  [...samples].reverse().map((g) => {
                    const p = matchParticipant(g, puuid),
                      s = p?.stats ?? {},
                      kda = (number(s.kills) + number(s.assists)) / Math.max(1, number(s.deaths)),
                      win = matchResult(g, p) === "win";
                    return (
                      <div
                        key={String(g.gameId)}
                        title={localize(
                          `${new Date(matchTimestamp(g)).toLocaleDateString()} · ${championInfo(number(p?.championId))?.chineseName ?? ""} · ${win ? "胜" : "负"} · KDA ${kda.toFixed(2)}`
                        )}
                        className={`min-w-0 flex-1 rounded-t ${win ? "bg-emerald-400/80" : "bg-rose-400/80"}`}
                        style={{ height: `${Math.max(5, Math.min(10, kda) * 10)}%` }}
                      />
                    );
                  })
                )}
              </div>
              <div className="text-ink-muted mt-3 flex gap-4">
                <span>{localize("绿色：胜利")}</span>
                <span>{localize("红色：失败")}</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {localize(
                [7, 30].map((days) => {
                  const list = recentDays(pool, days),
                    stats = aggregate(list, puuid);
                  const modes = new Map<string, number>();
                  for (const g of list) {
                    const mode = String(g.gameMode ?? "未知");
                    modes.set(mode, (modes.get(mode) ?? 0) + 1);
                  }
                  return (
                    <div key={days} className="bg-charcoal-500 rounded-lg p-4">
                      <p className="text-ink">
                        {localize("最近 ")}
                        {localize(days)}
                        {localize(" 天")}
                      </p>
                      <p className="text-ink-muted mt-2">
                        {localize(list.length)}
                        {localize(" 场 · ")}
                        {localize(stats.wins)}
                        {localize(" 胜 ")}
                        {localize(stats.losses)}
                        {localize(" 负 · 胜率")}
                        {localize(" ")}
                        {localize(list.length ? `${stats.rate}%` : "—")}
                        {localize(" · KDA ")}
                        {localize(list.length ? stats.kda : "—")}
                      </p>
                      <p className="text-ink-muted mt-2">
                        {localize("活跃")}
                        {localize(" ")}
                        {localize(
                          new Set(list.map((g) => new Date(matchTimestamp(g)).toLocaleDateString()))
                            .size
                        )}
                        {localize(" ")}
                        {localize("天 · 场均伤害")}
                        {localize(" ")}
                        {localize(
                          stats.damage == null ? "—" : `${(stats.damage / 1000).toFixed(1)}k`
                        )}
                      </p>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )
      )}
      {localize(
        !pool.length && (
          <p className="text-ink-muted py-10 text-center">
            {localize("当前还没有可用于分析的有效对局。")}
          </p>
        )
      )}
    </div>
  );
}
