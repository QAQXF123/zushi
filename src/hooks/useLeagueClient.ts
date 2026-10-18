import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
export interface ClientAccount {
  platform?: string; puuid: string; summonerId: number; gameName: string; tagLine: string;
  displayName: string; profileIconId: number; level: number;
}
export interface ClientSnapshot {
  connected: boolean; account: ClientAccount | null; phase: string; platform: string;
  championId: number; error: string | null;
}
const initial: ClientSnapshot = { connected: false, account: null, phase: "", platform: "", championId: 0, error: null };
export function accountName(account: ClientAccount): string {
  return `${account.gameName || account.displayName}${account.tagLine ? `#${account.tagLine}` : ""}`;
}
export function useLeagueClient(gamePath: string | null) {
  const [snapshot, setSnapshot] = useState(initial);
  const [autoLocate, setAutoLocateState] = useState(() => localStorage.getItem("zushi:auto-locate") !== "false");
  const setAutoLocate = useCallback((value: boolean) => {
    localStorage.setItem("zushi:auto-locate", String(value));
    setAutoLocateState(value);
  }, []);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await invoke<ClientSnapshot>("get_client_snapshot");
        if(next.account)next.account.platform=next.platform;
        if (!disposed) setSnapshot(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      } catch (error) {
        if (!disposed) setSnapshot({ ...initial, error: String(error) });
      }
      if (!disposed) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [gamePath]);
  return { snapshot, autoLocate, setAutoLocate };
}
