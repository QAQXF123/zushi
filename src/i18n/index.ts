import { useSyncExternalStore } from "react";
import messages from "./messages.json";
import { championCatalog } from "../lib/championCatalog";
export type Language = "zh" | "en";
let language: Language = "zh";
let revision = 0;
try {
  language = localStorage.getItem("zushi:language") === "en" ? "en" : "zh";
} catch {
  /* Use Chinese by default. */
}
const listeners = new Set<() => void>();
const zh = new Map<string, string>(),
  en = new Map<string, string>();
for (const [chinese, english] of messages) {
  if (!en.has(chinese)) en.set(chinese, english);
  zh.set(english, chinese);
}
for (const c of championCatalog) {
  en.set(c.chineseName, c.name);
  zh.set(c.name, c.chineseName);
  en.set(c.chineseTitle, c.title);
  zh.set(c.title, c.chineseTitle);
}
export const getLanguage = () => language;
export function setLanguage(next: Language) {
  if (next === language) return;
  language = next;
  try {
    localStorage.setItem("zushi:language", next);
  } catch {}
  document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  for (const notify of listeners) notify();
}
export function useLanguage() {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => `${language}:${revision}`,
    () => `${language}:${revision}`
  );
  return language;
}
export const uiLocale = () => (language === "zh" ? "zh-CN" : "en-US");
export function addSkinTranslations(pairs: Array<[string, string]>) {
  let changed = false;
  for (const [chinese, english] of pairs) {
    if (chinese && english && chinese !== "default" && zh.get(english) !== chinese) {
      en.set(chinese, english);
      zh.set(english, chinese);
      changed = true;
    }
  }
  if (changed) {
    revision++;
    for (const notify of listeners) notify();
  }
}
// Match complete UI messages only. Never translate fragments inside player names,
// filenames or paths; those are data rather than interface labels.
const formats: Array<[RegExp, (...args: string[]) => string, (...args: string[]) => string]> = [
  [
    /^Downloading (\d+) skins\.\.\.$/,
    (a) => `正在下载 ${a} 个皮肤…`,
    (a) => `Downloading ${a} skins…`,
  ],
  [/^Downloading (.+)\.\.\.$/, (a) => `正在下载 ${localize(a)}…`, (a) => `Downloading ${a}…`],
  [/^Adding (.+)\.\.\.$/, (a) => `正在添加 ${a}…`, (a) => `Adding ${a}…`],
  [
    /^当前已下载 (\d+) 个皮肤及炫彩，一次获取全部英雄，无需逐个点击$/,
    (a) => `当前已下载 ${a} 个皮肤及炫彩，一次获取全部英雄，无需逐个点击`,
    (a) => `${a} skins and chromas downloaded. Get every champion's skins in one action.`,
  ],
  [
    /^正在下载全部皮肤：(.+)$/,
    (a) => `正在下载全部皮肤：${a}`,
    (a) => `Downloading skin library: ${a}`,
  ],
  [
    /^正在导入 (\d+) \/ (\d+) · 新增 (\d+) · 跳过已有 (\d+)$/,
    (a, b, c, d) => `正在导入 ${a} / ${b} · 新增 ${c} · 跳过已有 ${d}`,
    (a, b, c, d) => `Importing ${a} / ${b} · Added ${c} · Existing ${d}`,
  ],
  [
    /^获取完成：新增 (\d+)，已有 (\d+) 个皮肤及炫彩$/,
    (a, b) => `获取完成：新增 ${a}，已有 ${b} 个皮肤及炫彩`,
    (a, b) => `Complete: ${a} added, ${b} already present`,
  ],
  [/^获取失败：(.+)$/, (a) => `获取失败：${a}`, (a) => `Download failed: ${localize(a)}`],

  [
    /^(\d+) skins?(?: · (\d+) customs?)?$/,
    (a, b) => `${a} 个皮肤${b ? ` · ${b} 个自定义模组` : ""}`,
    (a, b) => `${a} skins${b ? ` · ${b} custom mods` : ""}`,
  ],
  [/^(\d+) customs?$/, (a) => `${a} 个自定义模组`, (a) => `${a} custom mods`],
  [
    /^更新未完成，已保留 (\d+) 场：(.+)$/,
    (a, b) => `更新未完成，已保留 ${a} 场：${b}`,
    (a, b) => `Update incomplete; ${a} matches retained: ${localize(b)}`,
  ],
  [
    /^本地保存失败，当前记录仍可浏览：(.+)$/,
    (a) => `本地保存失败，当前记录仍可浏览：${a}`,
    (a) => `Could not save locally; current records remain available: ${localize(a)}`,
  ],
  [
    /^本地缓存无法读取，原文件已保留：(.+)$/,
    (a) => `本地缓存无法读取，原文件已保留：${a}`,
    (a) => `Could not read local cache; original file retained: ${localize(a)}`,
  ],

  [
    /^Download skin and (\d+) chromas?$/,
    (n) => `下载皮肤及 ${n} 个炫彩`,
    (n) => `Download skin and ${n} chromas`,
  ],
  [/^(.+) \(not available\)$/, (s) => `${s}（不可用）`, (s) => `${s} (not available)`],
  [
    /^(.+) \(base not downloaded\)$/,
    (s) => `${s}（尚未下载基础皮肤）`,
    (s) => `${s} (base not downloaded)`,
  ],
  [
    /^准备皮肤 (\d+) \/ (\d+)(?:（(\d+) 个使用缓存）)?$/,
    (a, b, c) => `准备皮肤 ${a} / ${b}${c ? `（${c} 个使用缓存）` : ""}`,
    (a, b, c) => `Preparing skins ${a} / ${b}${c ? ` (${c} cached)` : ""}`,
  ],
  [
    /^(\d+) 连(胜|败)$/,
    (a, b) => `${a} 连${b}`,
    (a, b) => `${a} ${b === "胜" ? "wins" : "losses"} in a row`,
  ],
  [/^最近 (\d+) 场$/, (a) => `最近 ${a} 场`, (a) => `Last ${a} matches`],
  [
    /^(\d+)% 胜率(?: · KDA (.+))?$/,
    (a, b) => `${a}% 胜率${b ? ` · KDA ${b}` : ""}`,
    (a, b) => `${a}% win rate${b ? ` · KDA ${b}` : ""}`,
  ],
  [/^上次同步 (.+)$/, (a) => `上次同步 ${a}`, (a) => `Last synced ${a}`],
  [/^英雄 (\d+)$/, (a) => `英雄 ${a}`, (a) => `Champion ${a}`],
  [/^装备 (\d+)$/, (a) => `装备 ${a}`, (a) => `Item ${a}`],
  [/^符文 (\d+)$/, (a) => `符文 ${a}`, (a) => `Rune ${a}`],
  [/^模式 (.+)$/, (a) => `模式 ${a}`, (a) => `Mode ${a}`],
  [/^队伍 (\d+)$/, (a) => `队伍 ${a}`, (a) => `Team ${a}`],
  [
    /^小队 (\d+)(?: · 第 (\d+) 名)?$/,
    (a, b) => `小队 ${a}${b ? ` · 第 ${b} 名` : ""}`,
    (a, b) => `Squad ${a}${b ? ` · Place ${b}` : ""}`,
  ],
  [/^(.+) 胜 \/ (.+) 负$/, (a, b) => `${a} 胜 / ${b} 负`, (a, b) => `${a} wins / ${b} losses`],
  [/^(.+) · 参团 (\d+)%$/, (a, b) => `${a} · 参团 ${b}%`, (a, b) => `${a} · KP ${b}%`],
  [/^(.+) ([IV]+)?$/, (a, b) => `${a} ${b ?? ""}`, (a, b) => `${en.get(a) ?? a} ${b ?? ""}`],
];
export function localize<T>(value: T): T {
  if (typeof value !== "string") return value;
  const text = value.trim(),
    table = language === "zh" ? zh : en;
  const translated = table.get(text);
  if (translated !== undefined)
    return (value.slice(0, value.indexOf(text)) +
      translated +
      value.slice(value.indexOf(text) + text.length)) as T;
  for (const [pattern, chinese, english] of formats) {
    const match = text.match(pattern);
    if (match)
      return (language === "zh" ? chinese(...match.slice(1)) : english(...match.slice(1))) as T;
  }
  return value;
}
