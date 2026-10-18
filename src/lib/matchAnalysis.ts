import { matchParticipant, matchResult, matchTimestamp, number, type Json } from "./matchHistory";
export const positions: Record<string, string> = {
  TOP: "上单",
  JUNGLE: "打野",
  MIDDLE: "中单",
  BOTTOM: "下路",
  UTILITY: "辅助",
  UNKNOWN: "未知",
};
export function positionOf(p?: Json): string {
  const value = String(
    p?.stats?.teamPosition ||
      p?.stats?.individualPosition ||
      p?.teamPosition ||
      p?.timeline?.lane ||
      ""
  ).toUpperCase();
  if (value === "MID") return "MIDDLE";
  if (value === "SUPPORT" || p?.timeline?.role === "DUO_SUPPORT") return "UTILITY";
  if (value === "BOT") return "BOTTOM";
  return positions[value] ? value : "UNKNOWN";
}
export function competitive(game: Json) {
  return (
    ![0, 3100, 830, 840, 850, 870, 880, 890].includes(number(game.queueId)) &&
    game.gameType !== "CUSTOM_GAME" &&
    game.gameMode !== "PRACTICETOOL"
  );
}
export function validGames(games: Json[], puuid: string) {
  return games.filter((g) => {
    const p = matchParticipant(g, puuid);
    return competitive(g) && p && ["win", "loss"].includes(matchResult(g, p));
  });
}
export function aggregate(games: Json[], puuid: string) {
  let wins = 0,
    kills = 0,
    deaths = 0,
    assists = 0,
    damage = 0,
    cs = 0,
    minutes = 0,
    damageSamples = 0;
  for (const game of games) {
    const p = matchParticipant(game, puuid),
      s = p?.stats ?? {};
    if (matchResult(game, p) === "win") wins++;
    kills += number(s.kills);
    deaths += number(s.deaths);
    assists += number(s.assists);
    if (s.totalDamageDealtToChampions != null) {
      damage += number(s.totalDamageDealtToChampions);
      damageSamples++;
    }
    cs += number(s.totalMinionsKilled) + number(s.neutralMinionsKilled);
    minutes += number(game.gameDuration) / 60;
  }
  return {
    games: games.length,
    wins,
    losses: games.length - wins,
    rate: games.length ? Math.round((wins / games.length) * 100) : 0,
    kda: ((kills + assists) / Math.max(1, deaths)).toFixed(2),
    damage: damageSamples ? Math.round(damage / damageSamples) : null,
    cs: minutes ? (cs / minutes).toFixed(1) : "—",
  };
}
export function performanceTags(game: Json, p: Json | undefined): string[] {
  if (!p || !competitive(game) || !Array.isArray(game.participants) || game.participants.length < 2)
    return [];
  const members = (game.participants as Json[]).filter(
    (x) =>
      number(x.teamId) === number(p.teamId) &&
      (!p.stats?.subteamId || x.stats?.subteamId === p.stats.subteamId)
  );
  if (members.length < 2) return [];
  return [
    ["输出最高", "totalDamageDealtToChampions"],
    ["承伤最高", "totalDamageTaken"],
    ["经济最高", "goldEarned"],
    ["视野最高", "visionScore"],
  ]
    .filter(
      ([, field]) =>
        p.stats?.[field] != null &&
        number(p.stats[field]) > 0 &&
        members.every(
          (x) => x.stats?.[field] != null && number(x.stats[field]) <= number(p.stats[field])
        )
    )
    .map(([label]) => label)
    .slice(0, 3);
}
export function streak(games: Json[], puuid: string) {
  const first = games[0];
  if (!first) return "暂无记录";
  const result = matchResult(first, matchParticipant(first, puuid));
  let n = 0;
  for (const g of games) {
    if (matchResult(g, matchParticipant(g, puuid)) !== result) break;
    n++;
  }
  return `${n} 连${result === "win" ? "胜" : "败"}`;
}
export function recentDays(games: Json[], days: number) {
  const since = Date.now() - days * 86_400_000;
  return games.filter((g) => matchTimestamp(g) >= since);
}
