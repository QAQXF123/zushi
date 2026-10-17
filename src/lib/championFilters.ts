import { championCatalog } from "./championCatalog.ts";
import type { Champion } from "../types";

export type Position = "top" | "jungle" | "mid" | "bot" | "support";
export const POSITION_OPTIONS: { id: Position | "all"; label: string }[] = [
  { id: "all", label: "全部" }, { id: "top", label: "上单" },
  { id: "jungle", label: "打野" }, { id: "mid", label: "中单" },
  { id: "bot", label: "下路" }, { id: "support", label: "辅助" },
];
const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s'.’&-]/g, "");
const index = new Map(championCatalog.flatMap((champion) =>
  [champion.key, champion.id, champion.name].map((name) => [normalize(name), champion] as const)
));
const aliases: Record<string, string[]> = {
  Ahri: ["狐狸"], MasterYi: ["剑圣", "易大师"], LeeSin: ["瞎子"],
  MissFortune: ["女枪", "好运姐"], Graves: ["男枪"], Ashe: ["寒冰"],
  MonkeyKing: ["猴子", "悟空"], TwistedFate: ["卡牌"], Alistar: ["牛头"],
  Malphite: ["石头人"], Blitzcrank: ["机器人"], Teemo: ["提莫"],
  JarvanIV: ["皇子"], Rengar: ["狮子狗"], Khazix: ["螳螂"],
  Fiddlesticks: ["稻草人"], Hecarim: ["人马"], Nasus: ["狗头"],
};
function localized(champion: string | Champion) {
  return typeof champion === "string" ? index.get(normalize(champion)) : index.get(champion.key);
}
export function championDisplayName(champion: string | Champion): string {
  return localized(champion)?.chineseName || (typeof champion === "string" ? champion : champion.name);
}
export function championPositions(champion: string | Champion): Position[] {
  return (localized(champion)?.positions ?? []) as Position[];
}
export function championMatchesSearch(champion: string | Champion, query: string): boolean {
  const q = normalize(query);
  if (!q) return true;
  const match = localized(champion);
  const original = typeof champion === "string" ? champion : `${champion.name} ${champion.id}`;
  return [original, match?.name ?? "", match?.id ?? "", match?.chineseName ?? "",
    match?.chineseTitle ?? "", ...(aliases[match?.id ?? ""] ?? [])]
    .some((name) => normalize(name).includes(q));
}
export const bundledChampions: Champion[] = championCatalog.map(({ id, key, name, title, tags }) =>
  ({ id, key, name, title, tags })).sort((a, b) => a.name.localeCompare(b.name));
