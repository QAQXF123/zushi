import type { DownloadedSkin } from "../types";

export interface DownloadGroup {
  base: DownloadedSkin | null;
  baseSkinName: string;
  chromas: { dl: DownloadedSkin; colors: string[] }[];
}
const indexCache = new WeakMap<DownloadedSkin[], Map<string, DownloadedSkin[]>>();
export function downloadedChampionIndex(downloads: DownloadedSkin[]) {
  let index = indexCache.get(downloads);
  if (index) return index;
  index = new Map();
  for (const skin of downloads) {
    const skins = index.get(skin.champion_name) ?? [];
    skins.push(skin);
    index.set(skin.champion_name, skins);
  }
  indexCache.set(downloads, index);
  return index;
}

export function groupDownloadedSkins(
  skins: DownloadedSkin[],
  lookup: (name: string) => { parentName: string; colors: string[] } | null,
): DownloadGroup[] {
  const groups = new Map<string, DownloadGroup>();
  for (const skin of skins) {
    const chroma = lookup(skin.skin_name);
    const name = chroma?.parentName ?? skin.skin_name;
    let group = groups.get(name);
    if (!group) {
      group = { base: null, baseSkinName: name, chromas: [] };
      groups.set(name, group);
    }
    if (chroma) group.chromas.push({ dl: skin, colors: chroma.colors });
    else group.base = skin;
  }
  return [...groups.values()];
}
