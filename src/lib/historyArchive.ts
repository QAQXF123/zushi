import { invoke } from "@tauri-apps/api/core";
import { accountName, type ClientAccount } from "../hooks/useLeagueClient";
import type { Json } from "./matchHistory";
export const playerKey = (p: Pick<ClientAccount, "puuid" | "platform">) =>
  `${p.platform || "UNKNOWN"}:${p.puuid}`;
export const readCache = <T>(kind: string, id: string) =>
  invoke<T | null>("read_history_cache", { kind, id });
const writes = new Map<string, Promise<void>>();
export function writeCache(kind: string, id: string, value: unknown): Promise<void> {
  const key = `${kind}:${id}`;
  const next = (writes.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => invoke<void>("write_history_cache", { kind, id, value }));
  writes.set(key, next);
  void next
    .finally(() => {
      if (writes.get(key) === next) writes.delete(key);
    })
    .catch(() => {});
  return next;
}
export const flushCache = (kind: string, id: string) =>
  writes.get(`${kind}:${id}`) ?? Promise.resolve();
export interface SavedPlayer {
  account: ClientAccount;
  favorite: boolean;
  note: string;
  seenAt: number;
  self?: boolean;
}
let registry: SavedPlayer[] = [];
let registryLoad: Promise<SavedPlayer[]> | undefined;
export async function loadPlayers() {
  await (registryLoad ??= readCache<SavedPlayer[]>("players", "registry")
    .then((list) => (registry = list ?? []))
    .catch((error) => {
      registryLoad = undefined;
      throw error;
    }));
  return registry;
}
export async function rememberPlayer(
  account: ClientAccount,
  changes: Partial<Omit<SavedPlayer, "account">> = {}
) {
  await loadPlayers();
  const key = playerKey(account),
    old = registry.find((p) => playerKey(p.account) === key);
  registry = [
    {
      favorite: false,
      note: "",
      ...old,
      ...changes,
      account: { ...old?.account, ...account },
      seenAt: Date.now(),
    },
    ...registry.filter((p) => playerKey(p.account) !== key),
  ];
  await writeCache("players", "registry", registry);
  window.dispatchEvent(new Event("zushi:players-changed"));
  return registry;
}
export function findLocalPlayers(query: string, players: SavedPlayer[]) {
  const term = query.trim().toLowerCase();
  return players.filter((p) => `${accountName(p.account)} ${p.note}`.toLowerCase().includes(term));
}
const profiles = new Map<string, Promise<Json>>();
export async function playerProfile(
  account: ClientAccount,
  online: boolean,
  force = false
): Promise<Json | null> {
  const key = playerKey(account),
    cached = await readCache<Json>("profile", key);
  if (!online || (!force && cached && Date.now() - cached.fetchedAt < 300_000)) return cached;
  let running = profiles.get(key);
  if (!running) {
    running = invoke<Json>("get_client_player_profile", {
      puuid: account.puuid,
      platform: account.platform,
    })
      .then(async (data) => {
        const value = {
          ...cached,
          ...data,
          ranked: data.ranked ?? cached?.ranked,
          account: data.account
            ? { ...data.account, platform: account.platform }
            : (cached?.account ?? account),
          fetchedAt: Date.now(),
        };
        await writeCache("profile", key, value);
        return value;
      })
      .finally(() => profiles.delete(key));
    profiles.set(key, running);
  }
  return running.catch((error) => {
    if (cached) return { ...cached, rankError: String(error) };
    throw error;
  });
}
// All foreground and prefetch callers share this queue and the same in-flight match request.
const details = new Map<string, Json>(),
  pending = new Map<string, Promise<Json>>();
const queue: Array<() => void> = [];
let active = 0;
function pump() {
  while (active < 3 && queue.length) {
    active++;
    queue.shift()!();
  }
}
export function matchDetail(
  game: Json,
  platform: string,
  useSgp: boolean,
  online: boolean
): Promise<Json> {
  const id = String(game.gameId),
    key = `${platform}:${id}`,
    cached = details.get(key);
  if (cached) return Promise.resolve(cached);
  const running = pending.get(key);
  if (running) return running;
  const request = new Promise<Json>((resolve, reject) => {
    queue.push(() => {
      void invoke<Json>("get_client_match_detail", {
        gameId: id,
        platform,
        useSgp: useSgp && game._source === "SGP",
        offline: !online,
      })
        .then((value) => {
          details.set(key, value);
          if (details.size > 100) details.delete(details.keys().next().value!);
          resolve(value);
        })
        .catch(reject)
        .finally(() => {
          active--;
          pending.delete(key);
          pump();
        });
    });
    pump();
  });
  pending.set(key, request);
  return request;
}
export function forgetHistoryMemory() {
  details.clear();
}

export async function syncRecentAccount(account: ClientAccount, useSgp: boolean) {
  const batch = await invoke<{
    games: Json[];
    source: string;
    count: number;
    notice: string | null;
  }>("get_client_match_history", {
    puuid: account.puuid,
    platform: account.platform,
    start: 0,
    count: 20,
    useSgp,
  });
  const key = playerKey(account),
    old = await readCache<import("./matchHistory").CachedHistory>("history", key);
  const games = new Map((old?.games ?? []).map((g) => [String(g.gameId), g]));
  let additions = 0;
  for (const g of batch.games) {
    const id = String(g.gameId),
      prior = games.get(id);
    if (!prior) additions++;
    if (!prior || (prior.participants?.length ?? 0) <= (g.participants?.length ?? 0))
      games.set(id, g);
  }
  const cursor = old?.cursors[batch.source];
  await writeCache("history", key, {
    ...old,
    games: [...games.values()],
    source: batch.source,
    notice: batch.notice,
    fetchedAt: Date.now(),
    cursors: {
      ...old?.cursors,
      [batch.source]: {
        offset: cursor ? Math.min(500, cursor.offset + additions) : batch.count,
        exhausted: cursor?.exhausted ?? batch.count < 20,
      },
    },
  });
}
