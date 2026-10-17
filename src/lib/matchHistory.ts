import { championCatalog } from "./championCatalog";
export type Json = Record<string, any>;
const champions = new Map(championCatalog.map(c => [Number(c.key), c]));
export function championInfo(id: number) { return champions.get(id); }
export function matchId(game: Json): string { return String(game.gameId ?? ""); }
export function matchParticipant(game: Json, puuid: string): Json | undefined {
  const participants = (game.participants ?? []) as Json[];
  const identity = ((game.participantIdentities ?? []) as Json[]).find(p => p.player?.puuid === puuid);
  return identity ? participants.find(p => p.participantId === identity.participantId) : participants.length === 1 ? participants[0] : undefined;
}
export function number(value: unknown): number { const n = Number(value); return Number.isFinite(n) ? n : 0; }
export function matchTimestamp(game: Json): number {
  return number(game.gameCreation) || Date.parse(String(game.gameCreationDate ?? "")) || 0;
}
export function matchResult(game: Json, participant?: Json): "win" | "loss" | "remake" | "unknown" {
  if ((participant?.stats?.gameEndedInEarlySurrender && number(game.gameDuration) <= 300) || /abort|cancel/i.test(String(game.endOfGameResult ?? ""))) return "remake";
  const win = participant?.stats?.win;
  return win === true || win === "Win" ? "win" : win === false || win === "Fail" ? "loss" : "unknown";
}
export function duration(seconds: unknown): string {
  const total = Math.max(0, Math.floor(number(seconds)));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
export function queueName(game: Json, queues: Record<number, string>): string {
  const id = number(game.queueId);
  return ({ 420: "单双排", 440: "灵活排位", 450: "极地大乱斗", 400: "征召匹配", 430: "匹配", 490: "快速模式", 1700: "斗魂竞技场", 1710:"斗魂竞技场", 3100:"训练模式", 2400:"海克斯大乱斗",830:"人机入门",840:"人机新手",850:"人机一般" } as Record<number, string>)[id] || queues[id] || (game.gameType === "CUSTOM_GAME" ? "自定义" : game.gameMode === "PRACTICETOOL" ? "训练模式" : `模式 ${id || game.gameMode || "未知"}`);
}
export interface CachedHistory { games: Json[]; exhausted: boolean; fetchedAt: number; offset: number; source?:string; notice?:string|null; }
const historyCache = new Map<string, CachedHistory>();
export function cachedHistory(puuid: string): CachedHistory | undefined { return historyCache.get(puuid); }
export function saveHistory(puuid: string, data: CachedHistory) {
  historyCache.delete(puuid);
  historyCache.set(puuid, data);
  if (historyCache.size > 6) historyCache.delete(historyCache.keys().next().value!);
}

export const matchModes:Record<string,{name:string;ids?:number[]}>={
  all:{name:"全部模式"},ranked:{name:"单双排",ids:[420]},flex:{name:"灵活排位",ids:[440]},normal:{name:"匹配 / 快速",ids:[400,430,490,480]},aram:{name:"极地大乱斗",ids:[450,2400]},arena:{name:"斗魂竞技场",ids:[1700,1710]},bot:{name:"人机",ids:[830,840,850,870,880,890]},practice:{name:"训练 / 自定义",ids:[0,3100]},
};
export function rankedQueues(data:Json|null):Json[]{
  const entries=data?.queueMap?Object.entries(data.queueMap).map(([type,v])=>({...v as Json,queueType:type})):Array.isArray(data?.queues)?data!.queues:[];
  return ["RANKED_SOLO_5x5","RANKED_FLEX_SR","CHERRY"].map(type=>entries.find((q:Json)=>q.queueType===type)).filter(Boolean) as Json[];
}
const tiers:Record<string,string>={IRON:"黑铁",BRONZE:"青铜",SILVER:"白银",GOLD:"黄金",PLATINUM:"铂金",EMERALD:"翡翠",DIAMOND:"钻石",MASTER:"大师",GRANDMASTER:"宗师",CHALLENGER:"王者"};
export function rankName(rank:Json){const tier=tiers[rank.tier];return tier?`${tier} ${["I","II","III","IV"].includes(rank.division||rank.rank)?rank.division||rank.rank:""}`:"未定级";}
