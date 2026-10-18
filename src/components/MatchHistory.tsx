import { localize } from "../i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  X,
  LoaderCircle,
  ArrowLeft,
  Star,
} from "lucide-react";
import { accountName, type ClientAccount } from "../hooks/useLeagueClient";
import { useMatchHistory } from "../hooks/useMatchHistory";
import { championAvatar } from "../hooks/useChampions";
import {
  championInfo,
  matchId,
  matchParticipant,
  matchResult,
  matchTimestamp,
  duration,
  queueName,
  number,
  matchModes,
  rankedQueues,
  rankName,
  type Json,
} from "../lib/matchHistory";
import {
  aggregate,
  performanceTags,
  positionOf,
  positions,
  validGames,
} from "../lib/matchAnalysis";
import {
  findLocalPlayers,
  loadPlayers,
  matchDetail,
  playerKey,
  playerProfile,
  readCache,
  rememberPlayer,
  writeCache,
  syncRecentAccount,
  type SavedPlayer,
} from "../lib/historyArchive";
import { GameImage, Loadout, useGameAssets, type GameAssets } from "./GameAssets";
import MatchAnalysis from "./MatchAnalysis";
import ChampSelectHistory from "./ChampSelectHistory";
const resultLabels = { win: "胜利", loss: "失败", remake: "重开", unknown: "未知" };
const resultColors = {
  win: "text-emerald-400",
  loss: "text-rose-400",
  remake: "text-ink-muted",
  unknown: "text-ink-muted",
};
function Avatar({ id, size = 36 }: { id: number; size?: number }) {
  const champion = championInfo(id);
  return (
    <GameImage
      path={id ? `/lol-game-data/assets/v1/champion-icons/${id}.png` : undefined}
      title={localize(champion?.chineseName ?? `英雄 ${id}`)}
      size={size}
      fallback={champion ? championAvatar(champion.id) : undefined}
    />
  );
}
function dateText(game: Json) {
  const timestamp = matchTimestamp(game);
  return timestamp
    ? new Date(timestamp).toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "时间未知";
}
type Tab = "history" | "heroes" | "trends" | "select";
interface ViewState {
  page: number;
  mode: string;
  hero: string;
  result: string;
  position: string;
  since: string;
  until: string;
  tab: Tab;
  scroll: number;
}
const defaultView = (): ViewState => ({
  page: 0,
  mode: "all",
  hero: "",
  result: "all",
  position: "all",
  since: "",
  until: "",
  tab: "history",
  scroll: 0,
});
interface Props {
  account: ClientAccount | null;
  connected: boolean;
  platform: string;
  phase: string;
}
export default function MatchHistory({ account, connected, platform, phase }: Props) {
  const [player, setPlayer] = useState<ClientAccount | null>(null),
    [self, setSelf] = useState<ClientAccount | null>(null);
  const [booted, setBooted] = useState(false),
    [saved, setSaved] = useState<SavedPlayer[]>([]);
  const [query, setQuery] = useState(""),
    [searching, setSearching] = useState(false),
    [searchError, setSearchError] = useState<string | null>(null);
  const [regionFilter, setRegionFilter] = useState("all"),
    [onlyFavorites, setOnlyFavorites] = useState(false),
    [note, setNote] = useState("");
  const [view, setView] = useState<ViewState>(defaultView),
    [viewReady, setViewReady] = useState("");
  const key = player ? playerKey(player) : "";
  const updateView = (next: Partial<ViewState>) => setView((old) => ({ ...old, ...next }));
  const [profile, setProfile] = useState<Json | null>(null),
    [profileLoading, setProfileLoading] = useState(false);
  const previous = useRef<ClientAccount[]>([]),
    [canGoBack, setCanGoBack] = useState(false);
  const lastAccount = useRef(""),
    searchGeneration = useRef(0),
    detailGeneration = useRef(0);
  const [detail, setDetail] = useState<Json | null>(null),
    [detailId, setDetailId] = useState<string | null>(null),
    [detailLoading, setDetailLoading] = useState(false),
    [detailError, setDetailError] = useState<string | null>(null);
  const connectionKey = `${platform}:${account?.puuid ?? ""}`;
  const [useSgp, setUseSgp] = useState(false),
    [resolvedRoute, setResolvedRoute] = useState(""),
    [cloudDialog, setCloudDialog] = useState(false);
  const [cloudRoute, setCloudRoute] = useState<{
      platform: string;
      host: string;
      approved?: boolean;
    } | null>(null),
    [cloudError, setCloudError] = useState("");
  const online = connected && !!platform && player?.platform === platform;
  const routeReady = !connected || resolvedRoute === connectionKey;
  const history = useMatchHistory(player, useSgp, online, routeReady);
  const assets = useGameAssets(connected),
    [queues, setQueues] = useState<Record<number, string>>({});
  const [cacheInfo, setCacheInfo] = useState<Json | null>(null),
    [clearArmed, setClearArmed] = useState(false);
  const scroll = useRef<HTMLDivElement>(null),
    scrollPosition = useRef(0),
    scrollPending = useRef<number | null>(null);
  const chosen = saved.find((p) => playerKey(p.account) === key);
  const report = (e: unknown) => setSearchError(String(e));
  useEffect(() => {
    let disposed = false;
    void Promise.allSettled([
      readCache<ClientAccount>("view", "last-player"),
      readCache<ClientAccount>("self", "current"),
      loadPlayers(),
    ]).then(([last, me, players]) => {
      if (disposed) return;
      const cachedSelf = me.status === "fulfilled" ? me.value : null;
      setSaved(players.status === "fulfilled" ? [...players.value] : []);
      setSelf(cachedSelf);
      setPlayer((last.status === "fulfilled" ? last.value : null) ?? cachedSelf);
      const failure = [last, me, players].find((result) => result.status === "rejected");
      if (failure?.status === "rejected") report(failure.reason);
      setBooted(true);
    });
    const changed = () => {
      void loadPlayers()
        .then((items) => {
          if (!disposed) setSaved([...items]);
        })
        .catch(report);
    };
    window.addEventListener("zushi:players-changed", changed);
    return () => {
      disposed = true;
      window.removeEventListener("zushi:players-changed", changed);
      searchGeneration.current++;
      detailGeneration.current++;
    };
  }, []);
  useEffect(() => {
    if (!booted || !account?.platform) return;
    const current = playerKey(account),
      changed = !!lastAccount.current && lastAccount.current !== current;
    if (lastAccount.current === current) return;
    lastAccount.current = current;
    setSelf(account);
    if (changed || !player) setPlayer(account);
    void rememberPlayer(account, { self: true }).catch(report);
    void writeCache("self", "current", account).catch(report);
  }, [booted, account?.puuid, account?.platform]);
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    void invoke<{ platform: string; host: string; approved: boolean }>("get_client_sgp_route")
      .then((route) => {
        if (disposed) return;
        setCloudRoute(route);
        setUseSgp(
          localStorage.getItem("zushi:sgp-disabled") !== "true" &&
            (route.approved || localStorage.getItem("zushi:sgp-consent-host") === route.host)
        );
      })
      .catch(() => {
        if (!disposed) setUseSgp(false);
      })
      .finally(() => {
        if (!disposed) setResolvedRoute(connectionKey);
      });
    return () => {
      disposed = true;
    };
  }, [connected, platform, account?.puuid]);
  const enableCloud = async () => {
    setCloudDialog(true);
    setCloudError("");
    try {
      setCloudRoute(await invoke("get_client_sgp_route"));
    } catch (e) {
      setCloudError(String(e));
    }
  };
  useEffect(() => {
    let disposed = false;
    setViewReady("");
    setDetailId(null);
    detailGeneration.current++;
    setProfile(null);
    setCacheInfo(null);
    setClearArmed(false);
    if (!player) {
      setView(defaultView());
      return;
    }
    void readCache<ViewState>("view", key)
      .then((stored) => {
        if (disposed) return;
        const next = { ...defaultView(), ...stored };
        setView(next);
        scrollPosition.current = next.scroll;
        scrollPending.current = next.scroll;
        setViewReady(key);
      })
      .catch((e) => {
        if (!disposed) {
          report(e);
          setView(defaultView());
          setViewReady(key);
        }
      });
    void rememberPlayer(player).catch(report);
    void writeCache("view", "last-player", player).catch(report);
    return () => {
      disposed = true;
    };
  }, [key]);
  useEffect(() => {
    setNote(chosen?.note ?? "");
  }, [key, chosen?.note]);
  useEffect(() => {
    if (!key || viewReady !== key) return;
    const timer = setTimeout(() => {
      void writeCache("view", key, { ...view, scroll: scrollPosition.current }).catch(report);
    }, 350);
    return () => clearTimeout(timer);
  }, [key, viewReady, view]);
  useEffect(() => {
    if (viewReady === key && history.hydrated && scrollPending.current !== null && scroll.current) {
      scroll.current.scrollTop = scrollPending.current;
      scrollPending.current = null;
    }
  }, [key, viewReady, history.hydrated, history.games.length, view.tab]);
  useEffect(() => {
    if (!player) return;
    let disposed = false;
    setProfileLoading(online);
    void readCache<Json>("profile", key)
      .then((cached) => {
        if (!disposed && cached) setProfile(cached);
      })
      .catch(report);
    void playerProfile(player, online)
      .then((data) => {
        if (!disposed) setProfile(data);
      })
      .catch((e) => {
        if (!disposed) setProfile((old) => ({ ...old, rankError: String(e) }));
      })
      .finally(() => {
        if (!disposed) setProfileLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [key, online]);
  useEffect(() => {
    let disposed = false;
    void readCache<Record<number, string>>("queues", "names")
      .then((cached) => {
        if (!disposed && cached) setQueues(cached);
      })
      .catch(() => {});
    if (connected)
      void invoke<Json[]>("get_client_queues")
        .then((list) => {
          const names = Object.fromEntries(
            list.map((q) => [number(q.id), q.description || q.name || ""])
          );
          if (!disposed) setQueues(names);
          return writeCache("queues", "names", names);
        })
        .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [connected]);
  const endSynced = useRef(false),
    endTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    if (!connected || phase === "InProgress" || phase === "GameStart") {
      endSynced.current = false;
      endTimers.current.forEach(clearTimeout);
      endTimers.current = [];
      return;
    }
    if (
      !self ||
      !connected ||
      !routeReady ||
      self.platform !== platform ||
      endSynced.current ||
      !["WaitingForStats", "PreEndOfGame", "EndOfGame"].includes(phase)
    )
      return;
    endSynced.current = true;
    for (const delay of [5000, 20000, 45000])
      endTimers.current.push(
        setTimeout(() => {
          if (player && playerKey(self) === playerKey(player)) void history.refresh();
          else void syncRecentAccount(self, useSgp).catch(report);
          void playerProfile(self, true, true)
            .then((value) => {
              if (player && playerKey(self) === playerKey(player)) setProfile(value);
            })
            .catch(report);
        }, delay)
      );
  }, [phase, key, connected, routeReady, self?.puuid, useSgp]);
  useEffect(
    () => () => {
      endTimers.current.forEach(clearTimeout);
      endTimers.current = [];
      endSynced.current = false;
    },
    [key, platform, connected]
  );
  const choosePlayer = (next: ClientAccount, remember = true) => {
    const enriched = { ...next, platform: next.platform || player?.platform || platform };
    if (remember && player && playerKey(player) !== playerKey(enriched)) {
      previous.current.push(player);
      if (previous.current.length > 30) previous.current.shift();
    }
    if (player && viewReady === key)
      void writeCache("view", key, { ...view, scroll: scrollPosition.current }).catch(report);
    setCanGoBack(previous.current.length > 0);
    searchGeneration.current++;
    setSearching(false);
    setSearchError(null);
    setPlayer(enriched);
    setDetailId(null);
    detailGeneration.current++;
  };
  const matchingSaved = findLocalPlayers(query, saved).filter(
    (p) => regionFilter === "all" || p.account.platform === regionFilter
  );
  const searchPlayer = async () => {
    if (!query.trim() || searching) return;
    const exact = matchingSaved.filter(
      (p) => accountName(p.account).toLowerCase() === query.trim().toLowerCase()
    );
    if (exact.length === 1) {
      choosePlayer(exact[0].account);
      return;
    }
    if (!connected || (regionFilter !== "all" && regionFilter !== platform)) {
      if (matchingSaved.length === 1) {
        choosePlayer(matchingSaved[0].account);
        return;
      }
      setSearchError(
        matchingSaved.length
          ? "请在本地匹配结果中选择玩家。"
          : "本地没有此玩家记录；查询新玩家需要连接对应区服客户端。"
      );
      return;
    }
    const gen = ++searchGeneration.current;
    setSearching(true);
    setSearchError(null);
    try {
      const found = await invoke<ClientAccount>("search_client_player", { riotId: query.trim() });
      if (gen === searchGeneration.current) choosePlayer({ ...found, platform });
    } catch (e) {
      if (gen === searchGeneration.current) report(e);
    } finally {
      if (gen === searchGeneration.current) setSearching(false);
    }
  };
  const openDetail = async (game: Json) => {
    const gen = ++detailGeneration.current;
    setDetailId(matchId(game));
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    try {
      const value = await matchDetail(game, player?.platform ?? "", useSgp, online);
      if (gen === detailGeneration.current) setDetail(value);
    } catch (e) {
      if (gen === detailGeneration.current) setDetailError(String(e));
    } finally {
      if (gen === detailGeneration.current) setDetailLoading(false);
    }
  };
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDetailId(null);
        detailGeneration.current++;
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  const filter = (next: Partial<ViewState>) => updateView({ ...next, page: 0, scroll: 0 });
  const filtered = useMemo(
    () =>
      history.games.filter((game) => {
        const p = matchParticipant(game, player?.puuid ?? "");
        const ids = matchModes[view.mode]?.ids;
        if (ids && !ids.includes(number(game.queueId))) return false;
        if (view.result !== "all" && matchResult(game, p) !== view.result) return false;
        if (view.position !== "all" && positionOf(p) !== view.position) return false;
        const timestamp = matchTimestamp(game);
        if (view.since && timestamp < new Date(`${view.since}T00:00:00`).getTime()) return false;
        if (view.until && timestamp >= new Date(`${view.until}T00:00:00`).getTime() + 86_400_000)
          return false;
        const champ = championInfo(number(p?.championId));
        return (
          !view.hero.trim() ||
          `${champ?.chineseName ?? ""} ${champ?.id ?? ""} ${champ?.chineseTitle ?? ""}`
            .toLowerCase()
            .includes(view.hero.trim().toLowerCase())
        );
      }),
    [
      history.games,
      player?.puuid,
      view.mode,
      view.result,
      view.position,
      view.since,
      view.until,
      view.hero,
    ]
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 10)),
    currentPage = Math.min(view.page, pages - 1);
  const visible = useMemo(
    () => filtered.slice(currentPage * 10, currentPage * 10 + 10),
    [filtered, currentPage]
  );
  useEffect(() => {
    if (!online || view.tab !== "history" || !viewReady) return;
    let disposed = false;
    // Only the visible ten records are prefetched, with three shared workers.
    const enriched: Json[] = [];
    let cursor = 0;
    const worker = async () => {
      while (!disposed && cursor < visible.length) {
        const g = visible[cursor++];
        try {
          enriched.push(await matchDetail(g, player?.platform ?? "", useSgp, true));
        } catch {
          /* An explicit click displays a useful error and can retry. */
        }
      }
    };
    void Promise.all([worker(), worker()]).then(() => {
      if (!disposed) void history.enrich(enriched);
    });
    return () => {
      disposed = true;
    };
  }, [visible, online, useSgp, key, view.tab, viewReady]);
  const sample = validGames(filtered, player?.puuid ?? ""),
    summary = aggregate(sample, player?.puuid ?? "");
  const shownPlayer = profile?.account ?? player;
  const recent = (
    query.trim()
      ? matchingSaved
      : saved.filter((p) => regionFilter === "all" || p.account.platform === regionFilter)
  )
    .filter((p) => !onlyFavorites || p.favorite)
    .slice(0, 12);
  const regions = [
    ...new Set([platform, ...saved.map((p) => p.account.platform ?? "")].filter(Boolean)),
  ];
  const changeFavorite = () => {
    if (player) void rememberPlayer(player, { favorite: !chosen?.favorite }).catch(report);
  };
  const saveNote = () => {
    if (player && note !== (chosen?.note ?? ""))
      void rememberPlayer(player, { note }).catch(report);
  };
  const clearPlayer = async () => {
    if (!clearArmed) {
      setClearArmed(true);
      return;
    }
    try {
      await history.clear();
      setProfile(null);
      setCacheInfo(null);
      setClearArmed(false);
    } catch (e) {
      report(e);
    }
  };
  return (
    <div className="relative flex h-full flex-col">
      <div className="border-border shrink-0 border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            disabled={!canGoBack}
            title={localize("返回上一个玩家")}
            onClick={() => {
              const p = previous.current.pop();
              if (p) choosePlayer(p, false);
            }}
            className="text-ink-muted cursor-pointer disabled:opacity-30"
          >
            <ArrowLeft size={16} />
          </button>
          <h1 className="text-ink text-sm font-medium">{localize("战绩助手")}</h1>
          <span className="text-ink-muted flex-1 text-xs">
            {localize(
              online ? (history.loading ? "正在后台更新" : "客户端已连接") : "离线 / 查看本地记录"
            )}
            {localize(" ·")}
            {localize(" ")}
            {localize(player?.platform || platform || "区服待识别")}
          </span>
          <button
            disabled={!connected || !routeReady || history.loading}
            onClick={() => {
              if (useSgp) {
                setUseSgp(false);
                localStorage.setItem("zushi:sgp-disabled", "true");
              } else void enableCloud();
            }}
            className="text-gold-400 cursor-pointer text-xs disabled:opacity-40"
          >
            {localize(useSgp ? "云端查询已启用" : "启用云端查询")}
          </button>
          {localize(
            (account || self) && (
              <button
                onClick={() => choosePlayer(account ?? self!)}
                className="text-gold-400 cursor-pointer text-xs"
              >
                {localize("我的战绩")}
              </button>
            )
          )}
          <button
            title={localize("刷新，只补充新战绩")}
            disabled={!online || history.loading || !routeReady}
            onClick={() => void history.refresh()}
            className="text-ink-muted cursor-pointer disabled:opacity-30"
          >
            <RefreshCw size={15} className={history.loading ? "animate-spin" : ""} />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void searchPlayer();
          }}
          className="mt-3 flex gap-2"
        >
          <select
            aria-label={localize("查询区服")}
            value={regionFilter}
            onChange={(e) => setRegionFilter(e.target.value)}
            className="bg-charcoal-500 text-ink rounded px-2 text-xs"
          >
            <option value="all">{localize("全部本地区服")}</option>
            {localize(
              regions.map((r) => (
                <option key={r} value={r}>
                  {localize(r)}
                  {localize(r === platform ? " · 当前连接" : "")}
                </option>
              ))
            )}
          </select>
          <div className="relative flex-1">
            <Search
              size={14}
              className="text-ink-muted pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
            />
            <input
              aria-label={localize("查询玩家")}
              placeholder={localize("玩家名字#标签 / 本地备注")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="bg-charcoal-500 border-border text-ink w-full rounded border py-2 pr-3 pl-9 text-xs outline-none"
            />
          </div>
          <button
            disabled={searching || !query.trim()}
            className="bg-gold-400 text-charcoal-600 flex cursor-pointer items-center gap-2 rounded px-4 text-xs disabled:opacity-40"
          >
            {localize(searching && <LoaderCircle size={13} className="animate-spin" />)}
            {localize("查询")}
          </button>
          <button
            type="button"
            onClick={() => setOnlyFavorites(!onlyFavorites)}
            className={`cursor-pointer rounded px-2 ${onlyFavorites ? "text-gold-400" : "text-ink-muted"}`}
            title={localize("只看收藏")}
          >
            <Star size={16} fill={onlyFavorites ? "currentColor" : "none"} />
          </button>
        </form>
        <div className="mt-2 flex items-center gap-2 overflow-x-auto text-[10px]">
          {localize(
            recent.map((p) => (
              <button
                key={playerKey(p.account)}
                onClick={() => choosePlayer(p.account)}
                title={p.note}
                className={`shrink-0 cursor-pointer rounded px-2 py-1 ${playerKey(p.account) === key ? "bg-gold-400/15 text-gold-400" : "bg-charcoal-500 text-ink-muted"}`}
              >
                {localize(p.favorite ? "★ " : "")}
                {localize(p.self ? "我的 · " : "")}
                {p.note || accountName(p.account)}
                {localize(" · ")}
                {localize(p.account.platform)}
              </button>
            ))
          )}
          {localize(
            !recent.length && (
              <span className="text-ink-muted py-1">
                {localize(onlyFavorites ? "暂无收藏玩家" : "查询过的玩家会保存在这里，可离线查看")}
              </span>
            )
          )}
        </div>
        <div className="mt-3 flex gap-1">
          {localize(
            (
              [
                ["history", "历史战绩"],
                ["heroes", "我的英雄"],
                ["trends", "近期趋势"],
                ["select", "选人助手"],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => filter({ tab: id })}
                className={`cursor-pointer rounded px-4 py-1.5 text-xs ${view.tab === id ? "bg-gold-400 text-charcoal-600" : "text-ink-muted hover:bg-charcoal-500"}`}
              >
                {localize(label)}
              </button>
            ))
          )}
        </div>
      </div>
      <div
        ref={scroll}
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop;
          scrollPosition.current = top;
          if (viewReady === key && Math.abs(top - view.scroll) > 32) updateView({ scroll: top });
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {localize(
          searchError && (
            <p role="alert" className="text-error mb-3 text-xs">
              {localize(searchError)}
            </p>
          )
        )}
        {localize(
          view.tab === "select" ? (
            <ChampSelectHistory
              phase={phase}
              connected={connected}
              platform={platform}
              useSgp={useSgp}
              onChoose={(p) => {
                choosePlayer(p);
                filter({ tab: "history" });
              }}
            />
          ) : (
            <>
              {localize(
                shownPlayer && (
                  <div className="bg-charcoal-500/70 mb-4 rounded-lg p-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <GameImage
                        path={`/lol-game-data/assets/v1/profile-icons/${shownPlayer.profileIconId}.jpg`}
                        title={localize("召唤师头像")}
                        size={46}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-ink truncate text-sm font-medium">
                          {accountName(shownPlayer)}
                          {localize(" ")}
                          <span className="text-ink-muted text-xs">
                            {localize("Lv.")}
                            {localize(shownPlayer.level || "—")}
                            {localize(" · ")}
                            {localize(player?.platform)}
                          </span>
                        </p>
                        <p className="text-ink-muted mt-1 text-[10px]">
                          {localize("本地已收录 ")}
                          {localize(history.games.length)}
                          {localize(" 场 · 筛选 ")}
                          {localize(filtered.length)}
                          {localize(" 场 · 有效样本")}
                          {localize(" ")}
                          {localize(sample.length)}
                          {localize(" 场 · ")}
                          {localize(summary.wins)}
                          {localize(" 胜 ")}
                          {localize(summary.losses)}
                          {localize(" 负 · 胜率")}
                          {localize(" ")}
                          {localize(sample.length ? `${summary.rate}%` : "—")}
                          {localize(" · KDA")}
                          {localize(" ")}
                          {localize(sample.length ? summary.kda : "—")}
                        </p>
                      </div>
                      <button
                        onClick={changeFavorite}
                        title={localize(chosen?.favorite ? "取消收藏" : "收藏玩家")}
                        className="text-gold-400 cursor-pointer"
                      >
                        <Star size={18} fill={chosen?.favorite ? "currentColor" : "none"} />
                      </button>
                      {localize(
                        rankedQueues(profile?.ranked).map((rank) => (
                          <div
                            key={rank.queueType}
                            className="bg-charcoal-400 rounded px-3 py-2 text-[10px]"
                          >
                            <p className="text-ink-muted">
                              {localize(
                                rank.queueType === "RANKED_SOLO_5x5"
                                  ? "单双排"
                                  : rank.queueType === "RANKED_FLEX_SR"
                                    ? "灵活排位"
                                    : "竞技场"
                              )}
                            </p>
                            <p className="text-gold-400 mt-1">
                              {localize(rankName(rank))}
                              {localize(
                                rank.tier && rank.tier !== "NONE"
                                  ? ` · ${number(rank.leaguePoints)} LP`
                                  : ""
                              )}
                            </p>
                            <p className="text-ink-muted mt-1">
                              {localize(number(rank.wins))}
                              {localize(" 胜 / ")}
                              {localize(number(rank.losses))}
                              {localize(" 负")}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="text-ink-muted mt-3 flex flex-wrap items-center gap-3 text-[10px]">
                      <input
                        aria-label={localize("玩家备注")}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        onBlur={saveNote}
                        maxLength={60}
                        placeholder={localize("添加玩家备注")}
                        className="bg-charcoal-400 text-ink rounded px-2 py-1 outline-none"
                      />
                      <span>
                        {localize(
                          history.fetchedAt
                            ? `上次同步 ${new Date(history.fetchedAt).toLocaleString("zh-CN")}`
                            : "尚未同步"
                        )}
                      </span>
                      <button
                        onClick={() =>
                          void invoke<Json>("get_history_cache_info")
                            .then(setCacheInfo)
                            .catch(report)
                        }
                        className="text-gold-400 cursor-pointer"
                      >
                        {localize("缓存信息")}
                      </button>
                      <button
                        onClick={() => void clearPlayer()}
                        onBlur={() => setClearArmed(false)}
                        className="cursor-pointer"
                      >
                        {localize(clearArmed ? "再次点击清除此玩家列表和资料" : "清除此玩家缓存")}
                      </button>
                    </div>
                    {localize(
                      cacheInfo && (
                        <p className="text-ink-muted mt-2 text-[10px]">
                          {localize("本地缓存 ")}
                          {localize((number(cacheInfo.bytes) / 1024 / 1024).toFixed(1))}
                          {localize(" MB ·")}
                          {localize(" ")}
                          {localize(
                            (cacheInfo.records ?? [])
                              .map(
                                (r: Json) =>
                                  `${({ history: "玩家战绩", profile: "玩家资料", detail: "对局详情", image: "图片" } as Record<string, string>)[r.kind] ?? r.kind} ${r.count}`
                              )
                              .join(" / ")
                          )}
                          {localize("（详情和图片为共享缓存）")}
                          <button
                            onClick={() => void invoke("open_history_cache_folder").catch(report)}
                            className="text-gold-400 ml-3 cursor-pointer"
                          >
                            {localize("打开缓存与诊断日志目录")}
                          </button>
                        </p>
                      )
                    )}
                    {localize(
                      profileLoading && (
                        <p className="text-ink-muted mt-2 text-[10px]">
                          {localize("正在更新账号资料和段位…")}
                        </p>
                      )
                    )}
                    {localize(
                      profile?.rankError && (
                        <p className="text-ink-muted mt-2 text-[10px]">
                          {localize("段位更新未完成：")}
                          {localize(profile.rankError)}
                        </p>
                      )
                    )}
                  </div>
                )
              )}
              {localize(
                !online && (
                  <p className="text-ink-muted mb-3 text-xs">
                    {localize(
                      history.games.length
                        ? "正在查看本地缓存，翻页和已缓存详情可离线使用。更新需连接对应区服客户端。"
                        : "连接并登录客户端后可获取战绩；已查询的记录会自动保存在本地。"
                    )}
                  </p>
                )
              )}
              {localize(
                history.notice && (
                  <p className="text-ink-muted mb-3 text-xs">{localize(history.notice)}</p>
                )
              )}
              {localize(
                history.cacheError && (
                  <p role="alert" className="text-error mb-3 text-xs">
                    {localize(history.cacheError)}
                  </p>
                )
              )}
              {localize(
                history.error && (
                  <p role="alert" className="text-error mb-3 text-xs">
                    {localize(history.error)}
                  </p>
                )
              )}
              {localize(
                history.loading && (
                  <p role="status" className="text-gold-400 mb-3 flex items-center gap-2 text-xs">
                    <LoaderCircle size={13} className="animate-spin" />
                    {localize("正在同步，已保留 ")}
                    {localize(history.games.length)}
                    {localize(" 场 · 本次最多查询 ")}
                    {localize(history.targetCount)}
                    {localize(" 场")}
                    <button
                      onClick={history.cancel}
                      className="text-ink-muted ml-auto cursor-pointer"
                    >
                      {localize("停止同步")}
                    </button>
                  </p>
                )
              )}
              {localize(
                view.tab === "heroes" || view.tab === "trends" ? (
                  <MatchAnalysis
                    games={filtered}
                    puuid={player?.puuid ?? ""}
                    tab={view.tab}
                    onHero={(hero) => filter({ hero, tab: "history" })}
                  />
                ) : (
                  <>
                    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                      <select
                        aria-label={localize("对局模式筛选")}
                        value={view.mode}
                        onChange={(e) => filter({ mode: e.target.value })}
                        className="bg-charcoal-500 rounded p-2"
                      >
                        {localize(
                          Object.entries(matchModes).map(([id, m]) => (
                            <option key={id} value={id}>
                              {localize(m.name)}
                            </option>
                          ))
                        )}
                      </select>
                      <select
                        aria-label={localize("胜负筛选")}
                        value={view.result}
                        onChange={(e) => filter({ result: e.target.value })}
                        className="bg-charcoal-500 rounded p-2"
                      >
                        <option value="all">{localize("全部胜负")}</option>
                        <option value="win">{localize("胜利")}</option>
                        <option value="loss">{localize("失败")}</option>
                        <option value="remake">{localize("重开")}</option>
                      </select>
                      <select
                        aria-label={localize("位置筛选")}
                        value={view.position}
                        onChange={(e) => filter({ position: e.target.value })}
                        className="bg-charcoal-500 rounded p-2"
                      >
                        <option value="all">{localize("全部位置")}</option>
                        {localize(
                          Object.entries(positions).map(([id, label]) => (
                            <option key={id} value={id}>
                              {localize(label)}
                            </option>
                          ))
                        )}
                      </select>
                      <input
                        aria-label={localize("英雄筛选")}
                        value={view.hero}
                        onChange={(e) => filter({ hero: e.target.value })}
                        placeholder={localize("英雄中文名 / 英文名")}
                        className="bg-charcoal-500 min-w-28 flex-1 rounded p-2 outline-none"
                      />
                      <input
                        aria-label={localize("开始日期")}
                        type="date"
                        value={view.since}
                        onChange={(e) => filter({ since: e.target.value })}
                        className="bg-charcoal-500 rounded p-2"
                      />
                      <span className="text-ink-muted">{localize("至")}</span>
                      <input
                        aria-label={localize("结束日期")}
                        type="date"
                        value={view.until}
                        onChange={(e) => filter({ until: e.target.value })}
                        className="bg-charcoal-500 rounded p-2"
                      />
                      <button
                        onClick={() => filter({ ...defaultView(), tab: view.tab })}
                        className="text-gold-400 cursor-pointer"
                      >
                        {localize("重置")}
                      </button>
                    </div>
                    <p className="text-ink-muted mb-3 text-[10px]">
                      {localize(
                        "筛选和统计基于已收录记录；有效样本排除人机、训练、自定义和重开。位置缺失的对局显示“未知”。"
                      )}
                    </p>
                    <div className="space-y-2">
                      {localize(
                        visible.map((game) => {
                          const p = matchParticipant(game, player?.puuid ?? ""),
                            s = p?.stats ?? {},
                            result = matchResult(game, p);
                          return (
                            <button
                              key={matchId(game)}
                              onClick={() => void openDetail(game)}
                              className={`bg-charcoal-500 hover:bg-charcoal-300 flex w-full cursor-pointer flex-wrap items-center gap-3 rounded-lg border-l-2 px-3 py-3 text-left ${result === "win" ? "border-emerald-400/60" : result === "loss" ? "border-rose-400/60" : "border-charcoal-100"}`}
                            >
                              <Avatar id={number(p?.championId)} />
                              <div className="w-28 shrink-0">
                                <p className="text-ink truncate text-xs">
                                  {localize(
                                    championInfo(number(p?.championId))?.chineseName ?? "未知英雄"
                                  )}
                                </p>
                                <p className="text-ink-muted mt-1 text-[10px]">
                                  {localize(queueName(game, queues))}
                                  {localize(" · ")}
                                  {localize(positions[positionOf(p)])}
                                </p>
                              </div>
                              <span className={`text-xs font-medium ${resultColors[result]}`}>
                                {localize(resultLabels[result])}
                              </span>
                              <div className="min-w-32 flex-1">
                                <p className="text-ink text-xs">
                                  {localize(number(s.kills))}
                                  {localize(" / ")}
                                  {localize(number(s.deaths))}
                                  {localize(" / ")}
                                  {localize(number(s.assists))}
                                </p>
                                <p className="text-ink-muted mt-1 text-[10px]">
                                  {localize("补刀 ")}
                                  {localize(
                                    number(s.totalMinionsKilled) + number(s.neutralMinionsKilled)
                                  )}
                                  {localize(" · 伤害")}
                                  {localize(" ")}
                                  {localize(
                                    s.totalDamageDealtToChampions == null
                                      ? "—"
                                      : `${(number(s.totalDamageDealtToChampions) / 1000).toFixed(1)}k`
                                  )}
                                </p>
                                <div className="mt-1 flex gap-1">
                                  {localize(
                                    performanceTags(game, p).map((tag) => (
                                      <span key={tag} className="text-gold-400 text-[9px]">
                                        {localize(tag)}
                                      </span>
                                    ))
                                  )}
                                </div>
                              </div>
                              <Loadout participant={p} assets={assets} compact />
                              <div className="text-ink-muted shrink-0 text-right text-[10px]">
                                <p>{localize(dateText(game))}</p>
                                <p className="mt-1">
                                  {localize(duration(game.gameDuration))}
                                  {localize(" · 查看详情")}
                                </p>
                              </div>
                              <ChevronRight size={13} className="text-ink-muted" />
                            </button>
                          );
                        })
                      )}
                    </div>
                    {localize(
                      !visible.length && !history.loading && (
                        <p className="text-ink-muted py-12 text-center text-sm">
                          {localize(
                            !booted || !history.hydrated
                              ? "正在读取本地记录…"
                              : history.games.length
                                ? "没有符合条件的对局，请重置筛选或继续加载。"
                                : player
                                  ? "还没有已收录战绩，可登录客户端后同步。"
                                  : "请登录客户端识别账号，或选择本地保存的玩家。"
                          )}
                        </p>
                      )
                    )}
                    {localize(
                      history.exhausted && history.games.length > 0 && (
                        <p className="text-ink-muted mt-3 text-xs">
                          {localize("当前数据源已返回全部可读取记录；本地旧记录会继续保留。")}
                        </p>
                      )
                    )}
                  </>
                )
              )}
            </>
          )
        )}
      </div>
      {localize(
        view.tab !== "select" && (
          <div className="border-border flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs">
            <div className="flex items-center gap-3">
              <button
                onClick={() => updateView({ page: currentPage - 1 })}
                disabled={currentPage === 0 || view.tab !== "history"}
                aria-label={localize("上一页")}
                className="cursor-pointer disabled:opacity-30"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-ink-muted">
                {localize(currentPage + 1)}
                {localize(" / ")}
                {localize(pages)}
                {localize(" 页 · 每页 10 场")}
              </span>
              <button
                onClick={() => updateView({ page: currentPage + 1 })}
                disabled={currentPage >= pages - 1 || view.tab !== "history"}
                aria-label={localize("下一页")}
                className="cursor-pointer disabled:opacity-30"
              >
                <ChevronRight size={16} />
              </button>
              <select
                aria-label={localize("跳转战绩页")}
                value={currentPage}
                onChange={(e) => updateView({ page: Number(e.target.value) })}
                className="bg-charcoal-500 rounded p-1"
              >
                {localize(
                  Array.from({ length: pages }, (_, i) => (
                    <option key={i} value={i}>
                      {localize("第 ")}
                      {localize(i + 1)}
                      {localize(" 页")}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div className="flex gap-4">
              <button
                disabled={!online || history.loading || history.exhausted || history.limitReached}
                onClick={() => void history.loadMore()}
                className="text-gold-400 cursor-pointer disabled:opacity-30"
              >
                {localize("再加载 100 场")}
              </button>
              <button
                disabled={!online || history.loading || history.exhausted || history.limitReached}
                onClick={() => void history.loadAll()}
                className="text-gold-400 cursor-pointer disabled:opacity-30"
              >
                {localize("获取最多 500 场")}
              </button>
            </div>
          </div>
        )
      )}
      {localize(
        cloudDialog && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={localize("云端战绩授权")}
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-6"
          >
            <div className="bg-charcoal-400 border-border max-w-lg rounded-lg border p-5">
              <h2 className="text-ink text-sm">{localize("启用云端战绩")}</h2>
              <p className="text-ink-muted mt-3 text-xs leading-6">
                {localize(
                  "读取客户端的登录授权，仅向当前区服的 Riot 战绩服务器查询。令牌不会写入磁盘、传给页面或发送到第三方。战绩缓存不包含登录凭据。"
                )}
              </p>
              <p className="text-gold-400 mt-3 text-xs break-all">
                {localize(
                  cloudError ||
                    (cloudRoute && `${cloudRoute.platform} · ${cloudRoute.host}`) ||
                    "正在识别区服…"
                )}
              </p>
              <div className="mt-4 flex justify-end gap-4 text-xs">
                <button onClick={() => setCloudDialog(false)} className="cursor-pointer">
                  {localize("取消")}
                </button>
                <button
                  disabled={!cloudRoute || !!cloudError}
                  onClick={() => {
                    if (cloudRoute) localStorage.setItem("zushi:sgp-consent-host", cloudRoute.host);
                    localStorage.removeItem("zushi:sgp-disabled");
                    setUseSgp(true);
                    setCloudDialog(false);
                  }}
                  className="bg-gold-400 text-charcoal-600 cursor-pointer rounded px-3 py-2 disabled:opacity-30"
                >
                  {localize("同意并启用")}
                </button>
              </div>
            </div>
          </div>
        )
      )}
      {localize(
        detailId && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={localize("对局详情")}
            className="bg-charcoal-400 absolute inset-0 z-20 flex flex-col"
          >
            <div className="border-border flex shrink-0 items-center gap-3 border-b px-4 py-3">
              <button
                onClick={() => {
                  setDetailId(null);
                  detailGeneration.current++;
                }}
                className="cursor-pointer"
                aria-label={localize("返回战绩列表")}
              >
                <ArrowLeft size={17} />
              </button>
              <span className="text-sm">{localize("对局详情")}</span>
              <span className="text-ink-muted flex-1 text-xs">
                {localize(
                  detail
                    ? `${queueName(detail, queues)} · ${dateText(detail)} · ${duration(detail.gameDuration)}`
                    : ""
                )}
              </span>
              <button
                onClick={() => {
                  setDetailId(null);
                  detailGeneration.current++;
                }}
                className="cursor-pointer"
                aria-label={localize("关闭详情")}
              >
                <X size={16} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {localize(
                detailLoading && (
                  <p className="text-gold-400 text-xs">
                    {localize("正在读取对局详情，优先使用本地缓存…")}
                  </p>
                )
              )}
              {localize(
                detailError && <p className="text-error text-xs">{localize(detailError)}</p>
              )}
              {localize(
                detail && (
                  <MatchPlayers
                    game={detail}
                    current={player?.puuid ?? ""}
                    onChoose={(p) => choosePlayer({ ...p, platform: player?.platform })}
                    assets={assets}
                    platform={player?.platform ?? ""}
                    online={online}
                  />
                )
              )}
            </div>
          </div>
        )
      )}
    </div>
  );
}
function MatchPlayers({
  game,
  current,
  onChoose,
  assets,
  platform,
  online,
}: {
  game: Json;
  current: string;
  onChoose: (player: ClientAccount) => void;
  assets: GameAssets;
  platform: string;
  online: boolean;
}) {
  const [metric, setMetric] = useState("totalDamageDealtToChampions"),
    [runes, setRunes] = useState<number | null>(null);
  const [profiles, setProfiles] = useState<Record<string, Json>>({});
  const participants = (Array.isArray(game.participants) ? game.participants : []) as Json[];
  const identities = (game.participantIdentities ?? []) as Json[];
  const labels: Record<string, string> = {
    totalDamageDealtToChampions: "伤害",
    totalDamageTaken: "承伤",
    goldEarned: "经济",
    cs: "补刀",
    visionScore: "视野",
    kills: "击杀",
    participation: "参团率",
  };
  const identity = (p: Json) =>
    identities.find((i) => number(i.participantId) === number(p.participantId))?.player ?? {};
  const asAccount = (p: Json): ClientAccount => {
    const i = identity(p),
      name = i.gameName || i.summonerName || "未知玩家";
    return {
      platform,
      puuid: i.puuid || "",
      summonerId: number(i.summonerId),
      gameName: name,
      tagLine: i.tagLine || "",
      displayName: name,
      profileIconId: number(i.profileIcon),
      level: 0,
    };
  };
  useEffect(() => {
    let disposed = false,
      cursor = 0;
    setProfiles({});
    const worker = async () => {
      while (!disposed && cursor < participants.length) {
        const p = participants[cursor++],
          account = asAccount(p);
        if (!account.puuid) continue;
        try {
          const data = await playerProfile(account, online);
          if (!disposed && data) setProfiles((old) => ({ ...old, [account.puuid]: data }));
        } catch {
          /* Individual rank failures do not prevent match details. */
        }
      }
    };
    void Promise.all([worker(), worker()]);
    return () => {
      disposed = true;
    };
  }, [game, platform, online]);
  const arena = participants.some((p) => number(p.stats?.subteamId) > 0);
  const groups = new Map<number, Json[]>();
  for (const p of participants) {
    const id = number(arena ? p.stats?.subteamId : p.teamId);
    groups.set(id, [...(groups.get(id) ?? []), p]);
  }
  const value = (p: Json) => {
    const s = p.stats ?? {};
    if (metric === "cs")
      return s.totalMinionsKilled == null && s.neutralMinionsKilled == null
        ? null
        : number(s.totalMinionsKilled) + number(s.neutralMinionsKilled);
    if (metric === "participation") {
      const members = groups.get(number(arena ? s.subteamId : p.teamId)) ?? [];
      const kills = members.reduce((n, x) => n + number(x.stats?.kills), 0);
      return kills ? Math.round(((number(s.kills) + number(s.assists)) / kills) * 100) : 0;
    }
    return s[metric] == null ? null : number(s[metric]);
  };
  const max = Math.max(1, ...participants.map((p) => value(p) ?? 0));
  return (
    <div className="space-y-4">
      <div className="text-ink-muted flex flex-wrap items-center gap-3 text-xs">
        <span className="flex-1">
          {localize(
            "点击玩家名字查看主页；段位为最近查询值，并非对局时段位。表现标签在本场同队成员中比较。"
          )}
        </span>
        <label>
          {localize("排序 / 对比")}
          {localize(" ")}
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value)}
            className="bg-charcoal-500 text-ink ml-2 rounded p-2"
          >
            {localize(
              Object.entries(labels).map(([id, label]) => (
                <option key={id} value={id}>
                  {localize(label)}
                </option>
              ))
            )}
          </select>
        </label>
      </div>
      {localize(
        [...groups.entries()]
          .sort(([a], [b]) => a - b)
          .map(([teamId, members], index) => {
            const team =
              ((game.teams ?? []) as Json[]).find((t) => number(t.teamId) === teamId) ?? {};
            const kills = members.reduce((sum, p) => sum + number(p.stats?.kills), 0),
              gold = members.reduce((sum, p) => sum + number(p.stats?.goldEarned), 0);
            const teamResult = members.some((p) => matchResult(game, p) === "remake")
              ? "重开"
              : team.win === true || team.win === "Win"
                ? "胜利"
                : team.win === false || team.win === "Fail"
                  ? "失败"
                  : members.some((p) => matchResult(game, p) === "win")
                    ? "胜利"
                    : members.some((p) => matchResult(game, p) === "loss")
                      ? "失败"
                      : "结果未知";
            const objective = (name: string, field: string) =>
              team.objectives?.[name]?.kills ?? team[field];
            const placement = number(members[0]?.stats?.subteamPlacement);
            const sorted = [...members].sort((a, b) => (value(b) ?? -1) - (value(a) ?? -1));
            return (
              <section key={teamId} className="border-border overflow-hidden rounded-lg border">
                <div
                  className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs ${index % 2 === 0 ? "bg-sky-500/10 text-sky-300" : "bg-rose-500/10 text-rose-300"}`}
                >
                  <strong>
                    {localize(
                      arena
                        ? `小队 ${teamId}${placement ? ` · 第 ${placement} 名` : ""}`
                        : teamId === 100
                          ? "蓝色方"
                          : teamId === 200
                            ? "红色方"
                            : `队伍 ${teamId}`
                    )}
                    {localize(" ")}
                    {localize("· ")}
                    {localize(teamResult)}
                  </strong>
                  <span>
                    {localize(kills)}
                    {localize(" 击杀 · 经济 ")}
                    {localize((gold / 1000).toFixed(1))}
                    {localize("k")}
                  </span>
                  {localize(
                    !arena && (
                      <span className="text-ink-muted text-[10px]">
                        {localize(
                          [
                            ["推塔", objective("tower", "towerKills")],
                            ["小龙", objective("dragon", "dragonKills")],
                            ["大龙", objective("baron", "baronKills")],
                          ]
                            .filter(([, v]) => v !== undefined)
                            .map(([name, v]) => `${name} ${v}`)
                            .join(" · ")
                        )}
                      </span>
                    )
                  )}
                </div>
                <div className="divide-border divide-y">
                  {localize(
                    sorted.map((p) => {
                      const account = asAccount(p),
                        s = p.stats ?? {},
                        amount = value(p),
                        cs = number(s.totalMinionsKilled) + number(s.neutralMinionsKilled);
                      const rank = rankedQueues(profiles[account.puuid]?.ranked)[0];
                      const runeIds = Array.from({ length: 6 }, (_, i) =>
                        number(s[`perk${i}`])
                      ).filter(Boolean);
                      return (
                        <div
                          key={p.participantId}
                          className={
                            account.puuid === current ? "bg-gold-400/10" : "bg-charcoal-500"
                          }
                        >
                          <div className="flex flex-wrap items-center gap-3 px-3 py-3">
                            <Avatar id={number(p.championId)} />
                            <div className="min-w-0 flex-1 basis-28">
                              <button
                                disabled={!account.puuid}
                                onClick={() => onChoose(account)}
                                className="text-ink hover:text-gold-400 max-w-full cursor-pointer truncate text-xs disabled:cursor-default"
                              >
                                {accountName(account)}
                                {localize(account.puuid === current ? " ★" : "")}
                              </button>
                              <p className="text-ink-muted mt-1 text-[10px]">
                                {localize(
                                  championInfo(number(p.championId))?.chineseName ??
                                    `英雄 ${p.championId}`
                                )}
                                {localize(" ")}
                                {localize("· ")}
                                {localize(positions[positionOf(p)])}
                                {localize(" · ")}
                                {localize(rank ? rankName(rank) : "段位暂不可用")}
                              </p>
                              <div className="mt-1 flex gap-2">
                                {localize(
                                  performanceTags(game, p).map((tag) => (
                                    <span key={tag} className="text-gold-400 text-[9px]">
                                      {localize(tag)}
                                    </span>
                                  ))
                                )}
                              </div>
                            </div>
                            <div className="w-24 shrink-0 text-center">
                              <p className="text-ink text-xs">
                                {localize(number(s.kills))}
                                {localize(" / ")}
                                {localize(number(s.deaths))}
                                {localize(" / ")}
                                {localize(number(s.assists))}
                              </p>
                              <p className="text-ink-muted mt-1 text-[10px]">
                                {localize("补刀 ")}
                                {localize(cs)}
                                {localize(" ·")}
                                {localize(" ")}
                                {localize(
                                  (cs / Math.max(1, number(game.gameDuration) / 60)).toFixed(1)
                                )}
                                {localize("/分")}
                              </p>
                              <p className="text-ink-muted mt-1 text-[10px]">
                                {localize("视野 ")}
                                {localize(s.visionScore == null ? "—" : number(s.visionScore))}
                                {localize(" · 插眼")}
                                {localize(" ")}
                                {localize(s.wardsPlaced == null ? "—" : number(s.wardsPlaced))}
                              </p>
                            </div>
                            <div className="w-24 shrink-0">
                              <p className="text-ink text-right text-[10px]">
                                {localize(labels[metric])}
                                {localize(" ")}
                                {localize(
                                  amount == null
                                    ? "—"
                                    : metric === "participation"
                                      ? `${amount}%`
                                      : amount >= 1000
                                        ? `${(amount / 1000).toFixed(1)}k`
                                        : amount
                                )}
                              </p>
                              <div className="bg-charcoal-300 mt-1 h-1 rounded">
                                <div
                                  className={
                                    index % 2 === 0 ? "h-full bg-sky-400" : "h-full bg-rose-400"
                                  }
                                  style={{ width: `${((amount ?? 0) / max) * 100}%` }}
                                />
                              </div>
                              <p className="text-ink-muted mt-2 text-right text-[10px]">
                                {localize("经济")}
                                {localize(" ")}
                                {localize(
                                  s.goldEarned == null
                                    ? "—"
                                    : `${(number(s.goldEarned) / 1000).toFixed(1)}k`
                                )}
                              </p>
                            </div>
                            <Loadout participant={p} assets={assets} />
                            <button
                              onClick={() =>
                                setRunes(
                                  runes === number(p.participantId) ? null : number(p.participantId)
                                )
                              }
                              className="text-gold-400 cursor-pointer text-[10px]"
                            >
                              {localize("符文")}
                            </button>
                          </div>
                          {localize(
                            runes === number(p.participantId) && (
                              <div className="border-border flex flex-wrap items-center gap-3 border-t px-4 py-3 text-xs">
                                {localize(
                                  runeIds.length ? (
                                    runeIds.map((id, i) => {
                                      const perk = assets.perks.find((x) => x.id === id);
                                      return (
                                        <span
                                          key={`${id}:${i}`}
                                          className="text-ink-muted flex items-center gap-2"
                                        >
                                          <GameImage
                                            path={perk?.iconPath}
                                            title={localize(perk?.name ?? `符文 ${id}`)}
                                            size={28}
                                          />
                                          {localize(perk?.name ?? `符文 ${id}`)}
                                        </span>
                                      );
                                    })
                                  ) : (
                                    <span className="text-ink-muted">
                                      {localize("此对局未提供完整符文数据。")}
                                    </span>
                                  )
                                )}
                              </div>
                            )
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            );
          })
      )}
    </div>
  );
}
