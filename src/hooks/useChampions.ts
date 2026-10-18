import { useState, useEffect, useMemo } from "react";
import type { Champion } from "../types";
import { getCached, setCache } from "../lib/cache";
import {
  bundledChampions,
  championMatchesSearch,
  championPositions,
  type Position,
} from "../lib/championFilters";

// Fallback when the version lookup fails; updated to the live latest at runtime.
const FALLBACK_VERSION = "16.20.1";
const VERSIONS_URL = "https://ddragon.leagueoflegends.com/api/versions.json";

const CACHE_KEY = "zushi:champions_v3";
const VERSION_CACHE_KEY = "zushi:ddragon_version";

let ddragonVersion = FALLBACK_VERSION;
let versionResolved: Promise<string> | null = null;

// Module-level cache so data survives component re-mounts
let championsCache: Champion[] | null = null;
const championIndex = new Map(bundledChampions.map((champion) => [champion.name, champion]));

function ensureVersion(): Promise<string> {
  if (versionResolved) return versionResolved;

  const cached = getCached<string>(VERSION_CACHE_KEY);
  if (cached) {
    ddragonVersion = cached;
    versionResolved = Promise.resolve(cached);
    return versionResolved;
  }

  versionResolved = fetch(VERSIONS_URL)
    .then((res) => (res.ok ? res.json() : Promise.reject()))
    .then((versions: string[]) => {
      if (versions[0]) ddragonVersion = versions[0];
      setCache(VERSION_CACHE_KEY, ddragonVersion);
      return ddragonVersion;
    })
    .catch(() => ddragonVersion);
  return versionResolved;
}

const bundledAvatars = import.meta.glob<string>("../assets/champions/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});
export function championAvatar(id: string): string {
  const local = bundledAvatars[`../assets/champions/${id}.png`];
  if (local) return local;
  return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${id}.png`;
}

export function splashUrl(championId: string, skinNum: number): string {
  return `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${championId}_${skinNum}.jpg`;
}

export function ensureChampions(): Promise<Champion[]> {
  if (championsCache) return Promise.resolve(championsCache);

  return ensureVersion().then(() => {
    const cached = getCached<Champion[]>(CACHE_KEY);
    if (cached) {
      championsCache = cached;
      for (const champion of cached) championIndex.set(champion.name, champion);
      return cached;
    }

    return fetch(
      `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/en_US/champion.json`
    )
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        const list: Champion[] = Object.values(json.data)
          // Skip Riot's "Classic"/Jade duplicate champions. They mirror real
          // champions but have no skins in the repo. No API flag marks them, so
          // match either signal: the reserved key block (60001+) or the id prefix.
          .filter((c: any) => parseInt(c.key, 10) < 60000 && !c.id.startsWith("Jade_"))
          .map((c: any) => ({
            id: c.id,
            key: c.key,
            name: c.name,
            title: c.title,
            tags: c.tags,
          }));
        list.sort((a, b) => a.name.localeCompare(b.name));
        championsCache = list;
        for (const champion of list) championIndex.set(champion.name, champion);
        setCache(CACHE_KEY, list);
        return list;
      })
      .catch(() => {
        championsCache = bundledChampions;
        return bundledChampions;
      });
  });
}

export function findChampionByName(name: string): Champion | undefined {
  return championIndex.get(name);
}

export function useChampions() {
  const [champions, setChampions] = useState<Champion[]>(championsCache ?? bundledChampions);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState<Position | "all">("all");

  useEffect(() => {
    if (championsCache) return;

    ensureChampions()
      .then((list) => setChampions(list))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(
    () =>
      champions.filter(
        (champion) =>
          championMatchesSearch(champion, search) &&
          (position === "all" || championPositions(champion).includes(position))
      ),
    [champions, search, position]
  );

  return {
    champions: filtered,
    total: champions.length,
    loading,
    error,
    search,
    setSearch,
    position,
    setPosition,
  };
}
