import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Search, RefreshCw, ChevronLeft, ChevronRight, X, LoaderCircle, ArrowLeft } from "lucide-react";
import { accountName, type ClientAccount } from "../hooks/useLeagueClient";
import { useMatchHistory } from "../hooks/useMatchHistory";
import { championAvatar } from "../hooks/useChampions";
import { championInfo, matchId, matchParticipant, matchResult, matchTimestamp, duration, queueName, number, matchModes, rankedQueues, rankName, type Json } from "../lib/matchHistory";
import { GameImage, Loadout, useGameAssets, type GameAssets } from "./GameAssets";
const detailCache = new Map<string, Json>();
const resultLabels = { win: "胜利", loss: "失败", remake: "重开", unknown: "未知" };
const resultColors = { win: "text-emerald-400", loss: "text-rose-400", remake: "text-ink-muted", unknown: "text-ink-muted" };
function Avatar({ id, size=36 }: { id: number; size?:number }) {
  const champion=championInfo(id);
  return <GameImage path={id?`/lol-game-data/assets/v1/champion-icons/${id}.png`:undefined} title={champion?.chineseName??`英雄 ${id}`} size={size} fallback={champion?championAvatar(champion.id):undefined}/>;
}
function dateText(game: Json) {
  const timestamp = matchTimestamp(game);
  return timestamp ? new Date(timestamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "时间未知";
}
interface Props { account: ClientAccount | null; connected: boolean; }
export default function MatchHistory({ account, connected }: Props) {
  const [player, setPlayer] = useState<ClientAccount | null>(account);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchGeneration = useRef(0);
  const lastAccount = useRef("");
  const [page, setPage] = useState(0);
  const [mode,setMode]=useState("all");
  const [heroFilter,setHeroFilter]=useState("");
  const [resultFilter,setResultFilter]=useState("all");
  const [profile,setProfile]=useState<Json|null>(null);
  const [profileLoading,setProfileLoading]=useState(false);
  const previousPlayers=useRef<ClientAccount[]>([]);
  const [canGoBack,setCanGoBack]=useState(false);
  const assets=useGameAssets(connected);
  const [queues, setQueues] = useState<Record<number, string>>({});
  const [detail, setDetail] = useState<Json | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailGeneration = useRef(0);
  const [useSgp,setUseSgp]=useState(false);
  const [cloudDialog,setCloudDialog]=useState(false);
  const [cloudRoute,setCloudRoute]=useState<{platform:string;host:string}|null>(null);
  const [cloudError,setCloudError]=useState("");
  const history = useMatchHistory(player?.puuid,useSgp);
  useEffect(()=>{
    if(!connected)return;
    let disposed=false;
    invoke<{host:string;approved:boolean}>("get_client_sgp_route").then(route=>{
      if(!disposed&&localStorage.getItem("zushi:sgp-disabled")!=="true"&&(route.approved||localStorage.getItem("zushi:sgp-consent-host")===route.host))setUseSgp(true);
    }).catch(()=>{});
    return()=>{disposed=true;};
  },[connected,account?.puuid]);
  const enableCloud=async()=>{
    setCloudDialog(true);setCloudRoute(null);setCloudError("");
    try{setCloudRoute(await invoke<{platform:string;host:string}>("get_client_sgp_route"));}catch(error){setCloudError(String(error));}
  };
  useEffect(() => {
    if (!account || lastAccount.current === account.puuid) return;
    lastAccount.current = account.puuid;
    searchGeneration.current++; detailGeneration.current++;
    setSearching(false); setPlayer(account); setSearchError(null); setDetailId(null);
  }, [account?.puuid]);
  useEffect(() => { setPage(0); setDetailId(null); detailGeneration.current++; setMode("all");setHeroFilter("");setResultFilter("all");setProfile(null); }, [player?.puuid]);
  useEffect(()=>{setPage(0);},[mode,heroFilter,resultFilter]);
  useEffect(()=>{
    if(!player?.puuid||!connected)return;
    let disposed=false;setProfileLoading(true);
    invoke<Json>("get_client_player_profile",{puuid:player.puuid}).then(data=>{if(!disposed)setProfile(data);}).catch(error=>{if(!disposed)setProfile({rankError:String(error)});}).finally(()=>{if(!disposed)setProfileLoading(false);});
    return()=>{disposed=true;};
  },[player?.puuid,connected]);
  useEffect(() => () => { searchGeneration.current++; detailGeneration.current++; }, []);
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    invoke<Json[]>("get_client_queues").then(list => {
      if (!disposed) setQueues(Object.fromEntries(list.map(q => [number(q.id), q.description || q.name || ""])));
    }).catch(() => {});
    return () => { disposed = true; };
  }, [connected]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setDetailId(null); detailGeneration.current++; } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  const choosePlayer = (next: ClientAccount, remember=true) => {
    if(remember&&player&&player.puuid!==next.puuid){previousPlayers.current.push(player);if(previousPlayers.current.length>10)previousPlayers.current.shift();}
    setCanGoBack(previousPlayers.current.length>0);
    searchGeneration.current++; setSearching(false); setSearchError(null); setPlayer(next); setPage(0); setDetailId(null); detailGeneration.current++;
  };
  const searchPlayer = async () => {
    if (!query.trim() || searching || !connected) return;
    const gen = ++searchGeneration.current;
    setSearching(true); setSearchError(null);
    try {
      const found = await invoke<ClientAccount>("search_client_player", { riotId: query.trim() });
      if (gen === searchGeneration.current) choosePlayer(found);
    } catch (e) { if (gen === searchGeneration.current) setSearchError(String(e)); }
    finally { if (gen === searchGeneration.current) setSearching(false); }
  };
  const openDetail = async (game: Json) => {
    const id = matchId(game); const cacheId=`${game._source??"LCU"}:${id}`; const gen = ++detailGeneration.current;
    setDetailId(id); setDetailError(null);
    const cached = detailCache.get(cacheId);
    setDetail(cached ?? null); setDetailLoading(!cached);
    if (cached) return;
    try {
      const data = await invoke<Json>("get_client_match_detail", { gameId: id, useSgp:useSgp&&game._source==="SGP" });
      if (gen !== detailGeneration.current) return;
      detailCache.set(cacheId, data);
      if (detailCache.size > 20) detailCache.delete(detailCache.keys().next().value!);
      setDetail(data);
    } catch (e) { if (gen === detailGeneration.current) setDetailError(String(e)); }
    finally { if (gen === detailGeneration.current) setDetailLoading(false); }
  };
  const filtered=useMemo(()=>history.games.filter(game=>{
    const p=matchParticipant(game,player?.puuid??"");
    const ids=matchModes[mode]?.ids;
    if(ids&&!ids.includes(number(game.queueId)))return false;
    if(resultFilter!=="all"&&matchResult(game,p)!==resultFilter)return false;
    const champ=championInfo(number(p?.championId));
    return !heroFilter.trim()||`${champ?.chineseName??""} ${champ?.id??""} ${champ?.chineseTitle??""}`.toLowerCase().includes(heroFilter.trim().toLowerCase());
  }),[history.games,player?.puuid,mode,heroFilter,resultFilter]);
  const heroStats=useMemo(()=>{
    const map=new Map<number,{id:number;games:number;wins:number}>();
    for(const game of history.games){const p=matchParticipant(game,player?.puuid??"");if(!p)continue;const id=number(p.championId);const entry=map.get(id)??{id,games:0,wins:0};entry.games++;if(matchResult(game,p)==="win")entry.wins++;map.set(id,entry);}
    return [...map.values()].sort((a,b)=>b.games-a.games).slice(0,5);
  },[history.games,player?.puuid]);
  const shownPlayer=profile?.account??player;
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * 10, currentPage * 10 + 10);
  const summary = useMemo(() => {
    let wins = 0, losses = 0, kills = 0, deaths = 0, assists = 0;
    for (const game of filtered) {
      const p = matchParticipant(game, player?.puuid ?? "");
      const result = matchResult(game, p);
      if (result === "win") wins++; if (result === "loss") losses++;
      kills += number(p?.stats?.kills); deaths += number(p?.stats?.deaths); assists += number(p?.stats?.assists);
    }
    return { wins, losses, rate: wins + losses ? `${Math.round(wins / (wins + losses) * 100)}%` : "—", kda: deaths ? ((kills + assists) / deaths).toFixed(2) : kills + assists ? "完美" : "—" };
  }, [filtered, player?.puuid]);
  return (
    <div className="relative flex h-full flex-col">
      <div className="border-border shrink-0 border-b px-4 py-3">
        <div className="flex items-center gap-3">
          {canGoBack&&<button title="返回上一个玩家" onClick={()=>{const previous=previousPlayers.current.pop();if(previous)choosePlayer(previous,false);}} className="text-ink-muted cursor-pointer"><ArrowLeft size={16}/></button>}
          <h1 className="text-ink text-sm font-medium">战绩查询</h1>
          <span className="text-ink-muted flex-1 text-xs">{history.source|| (useSgp?"SGP 云端战绩":"LCU 客户端战绩")}</span>
          <button onClick={()=>{if(useSgp){setUseSgp(false);localStorage.setItem("zushi:sgp-disabled","true");}else void enableCloud();}} disabled={!connected||history.loading} className="text-gold-400 shrink-0 cursor-pointer text-xs disabled:opacity-40">{useSgp?"关闭云端查询":"启用云端战绩"}</button>
          {account && <button onClick={() => choosePlayer(account)} className="text-gold-400 cursor-pointer text-xs">我的战绩</button>}
          <button onClick={() => { setPage(0); void history.refresh(); }} disabled={!connected || !player || history.loading} aria-label="刷新战绩" className="text-ink-muted hover:text-ink cursor-pointer disabled:opacity-30"><RefreshCw size={15} /></button>
        </div>
        <form onSubmit={e => { e.preventDefault(); void searchPlayer(); }} className="mt-3 flex gap-2">
          <div className="relative flex-1"><Search size={14} className="text-ink-muted pointer-events-none absolute top-1/2 left-3 -translate-y-1/2" /><input aria-label="查询玩家" placeholder="输入玩家名字#标签，也可尝试客户端显示名" value={query} onChange={e => setQuery(e.target.value)} className="bg-charcoal-500 border-border text-ink placeholder:text-ink-muted focus:border-gold-400 w-full rounded-md border py-2 pr-3 pl-9 text-xs outline-none" /></div>
          <button type="submit" disabled={!connected || searching || !query.trim()} className="bg-gold-400 text-charcoal-600 flex cursor-pointer items-center gap-1.5 rounded-md px-4 text-xs font-medium disabled:cursor-default disabled:opacity-40">{searching && <LoaderCircle size={13} className="animate-spin" />}查询</button>
        </form>
        {shownPlayer&&<div className="mt-3 flex items-center gap-3">
          <GameImage path={`/lol-game-data/assets/v1/profile-icons/${shownPlayer.profileIconId}.jpg`} title="召唤师头像" size={46}/>
          <div className="min-w-0 flex-1"><p className="text-ink truncate text-sm font-medium">{accountName(shownPlayer)} <span className="text-ink-muted text-[10px]">{shownPlayer.level?`Lv.${shownPlayer.level}`:""}</span></p><p className="text-ink-muted mt-1 text-[10px]">已读取 {history.games.length} 场 · 当前筛选 {filtered.length} 场 · <span className="text-emerald-400">{summary.wins} 胜</span> / <span className="text-rose-400">{summary.losses} 负</span> · 胜率 {summary.rate} · KDA {summary.kda}</p></div>
          {rankedQueues(profile?.ranked).map(rank=><div key={rank.queueType} className="bg-charcoal-500 rounded px-3 py-2 text-[10px]"><p className="text-ink-muted">{rank.queueType==="RANKED_SOLO_5x5"?"单双排":rank.queueType==="RANKED_FLEX_SR"?"灵活排位":"竞技场"}</p><p className="text-gold-400 mt-1 font-medium">{rankName(rank)}{rank.tier&&rank.tier!=="NONE"?` · ${number(rank.leaguePoints)} LP`:""}</p><p className="text-ink-muted mt-1">{number(rank.wins)} 胜 / {number(rank.losses)} 负</p></div>)}
        </div>}
        {profileLoading&&<p className="text-ink-muted mt-2 text-[10px]">正在读取账号资料和段位…</p>}
        {profile?.ranked&&!rankedQueues(profile.ranked).length&&<p className="text-ink-muted mt-2 text-[10px]">客户端未提供排位信息</p>}
        {profile?.rankError&&<p className="text-ink-muted mt-2 text-[10px]">段位暂不可用：{profile.rankError}</p>}
        {history.games.length>0&&<div className="mt-3 flex items-center gap-1 overflow-x-auto"><span className="text-ink-muted mr-1 shrink-0 text-[10px]">最近 20 场</span>{history.games.slice(0,20).map(game=>{const p=matchParticipant(game,player?.puuid??"");const result=matchResult(game,p);return <button key={matchId(game)} onClick={()=>void openDetail(game)} title={`${championInfo(number(p?.championId))?.chineseName??"未知英雄"} · ${resultLabels[result]} · ${queueName(game,queues)}`} className={`shrink-0 cursor-pointer rounded border-b-2 pb-0.5 ${result==="win"?"border-emerald-400":result==="loss"?"border-rose-400":"border-charcoal-100"}`}><Avatar id={number(p?.championId)} size={22}/></button>;})}</div>}
        {heroStats.length>0&&<div className="mt-3 flex flex-wrap items-center gap-2"><span className="text-ink-muted text-[10px]">常用英雄</span>{heroStats.map(hero=><button key={hero.id} title="筛选此英雄" onClick={()=>setHeroFilter(championInfo(hero.id)?.chineseName??String(hero.id))} className="bg-charcoal-500 hover:bg-charcoal-300 text-ink-muted flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[10px]"><span className="text-ink">{championInfo(hero.id)?.chineseName??hero.id}</span>{hero.games} 场 · {Math.round(hero.wins/hero.games*100)}%</button>)}</div>}
        <div className="mt-3 flex items-center gap-2 text-xs">
          <select aria-label="对局模式筛选" value={mode} onChange={e=>setMode(e.target.value)} className="bg-charcoal-500 text-ink rounded border border-border px-2 py-1.5">{Object.entries(matchModes).map(([key,value])=><option key={key} value={key}>{value.name}</option>)}</select>
          <select aria-label="胜负筛选" value={resultFilter} onChange={e=>setResultFilter(e.target.value)} className="bg-charcoal-500 text-ink rounded border border-border px-2 py-1.5"><option value="all">全部胜负</option><option value="win">胜利</option><option value="loss">失败</option><option value="remake">重开</option></select>
          <input aria-label="战绩英雄筛选" placeholder="英雄中文名 / 英文名" value={heroFilter} onChange={e=>setHeroFilter(e.target.value)} className="bg-charcoal-500 border-border text-ink min-w-0 flex-1 rounded border px-2 py-1.5 outline-none"/>
          {(mode!=="all"||heroFilter||resultFilter!=="all")&&<button onClick={()=>{setMode("all");setHeroFilter("");setResultFilter("all");}} className="text-gold-400 cursor-pointer">清除筛选</button>}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!connected && <p className="text-ink-muted mb-3 text-xs">{history.games.length ? "客户端未连接，已读取的记录仍可查看；登录后可继续查询。" : "请打开并登录英雄联盟客户端，连接后自动读取自己的战绩。"}</p>}
        {searchError && <p role="alert" className="text-error mb-3 text-xs">{searchError}</p>}
        {history.notice&&<p className="text-ink-muted mb-3 text-xs">{history.notice}</p>}
        {history.error && <p role="alert" className="text-error mb-3 text-xs">{history.error}</p>}
        {history.loading && <p role="status" className="text-gold-400 mb-3 flex items-center gap-2 text-xs"><LoaderCircle size={13} className="animate-spin" />正在读取 {history.games.length} / {history.targetCount} 场<button onClick={history.cancel} className="text-ink-muted ml-auto cursor-pointer">停止读取</button></p>}
        {visible.length === 0 && !history.loading && <p className="text-ink-muted py-12 text-center text-sm">{player ? history.games.length?"已加载的记录没有符合筛选条件的对局，可清除筛选或继续加载。":"客户端暂无可读取的对局记录" : "等待客户端账号登录"}</p>}
        <div className="space-y-2">
          {visible.map(game => {
            const p = matchParticipant(game, player?.puuid ?? ""); const stats = p?.stats ?? {}; const result = matchResult(game, p);
            return <button key={matchId(game)} onClick={() => void openDetail(game)} className={`bg-charcoal-500 hover:bg-charcoal-300 flex w-full cursor-pointer items-center gap-3 rounded-md border-l-2 px-3 py-2.5 text-left transition-colors ${result === "win" ? "border-emerald-400/60" : result === "loss" ? "border-rose-400/60" : "border-charcoal-100"}`}>
              <Avatar id={number(p?.championId)} />
              <div className="min-w-0 w-28 shrink-0"><p className="text-ink truncate text-xs">{championInfo(number(p?.championId))?.chineseName ?? `英雄 ${p?.championId ?? "未知"}`}</p><p className="text-ink-muted mt-1 truncate text-[10px]">{queueName(game, queues)}</p></div>
              <span className={`w-9 shrink-0 text-xs font-medium ${resultColors[result]}`}>{resultLabels[result]}</span>
              <div className="min-w-0 flex-1"><p className="text-ink text-xs tabular-nums">{number(stats.kills)} / {number(stats.deaths)} / {number(stats.assists)}</p><p className="text-ink-muted mt-1 text-[10px]">补刀 {number(stats.totalMinionsKilled) + number(stats.neutralMinionsKilled)} · 金币 {(number(stats.goldEarned)/1000).toFixed(1)}k · 伤害 {(number(stats.totalDamageDealtToChampions)/1000).toFixed(1)}k</p></div>
              <Loadout participant={p} assets={assets} compact/><div className="text-ink-muted shrink-0 text-right text-[10px]"><p>{dateText(game)}</p><p className="mt-1">{duration(game.gameDuration)} · 查看详情</p></div>
              <ChevronRight size={13} className="text-ink-muted shrink-0" />
            </button>;
          })}
        </div>
        {history.exhausted && history.games.length > 0 && <p className="text-ink-muted mt-3 text-xs">{history.source==="SGP"?"战绩服务器":"客户端"}已返回全部可读取记录，共 {history.games.length} 场。</p>}
      </div>
      <div className="border-border flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs">
        <div className="flex items-center gap-3"><button aria-label="战绩上一页" onClick={() => setPage(currentPage-1)} disabled={currentPage===0} className="text-ink cursor-pointer disabled:opacity-30"><ChevronLeft size={16} /></button><span className="text-ink-muted">{currentPage+1} / {pages} 页 · 每页 10 场</span><button aria-label="战绩下一页" onClick={() => setPage(currentPage+1)} disabled={currentPage>=pages-1} className="text-ink cursor-pointer disabled:opacity-30"><ChevronRight size={16} /></button><select aria-label="跳转战绩页" value={currentPage} onChange={e => setPage(Number(e.target.value))} className="bg-charcoal-500 text-ink rounded px-2 py-1">{Array.from({length:pages},(_,i)=><option key={i} value={i}>第 {i+1} 页</option>)}</select></div>
        <div className="flex items-center gap-3"><button onClick={() => void history.loadMore()} disabled={!connected || !player || history.loading || history.exhausted || history.limitReached} className="text-gold-400 cursor-pointer disabled:cursor-default disabled:opacity-30">再加载 100 场</button><button onClick={() => void history.loadAll()} disabled={!connected || !player || history.loading || history.exhausted || history.limitReached} className="text-ink-muted hover:text-gold-400 cursor-pointer disabled:cursor-default disabled:opacity-30">获取最多 500 场</button></div>
      </div>
      {cloudDialog&&<div role="dialog" aria-modal="true" aria-label="云端战绩授权" className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-6"><div className="bg-charcoal-400 border-border max-w-lg rounded-lg border p-5"><h2 className="text-ink text-sm font-medium">启用 SGP 云端战绩</h2><p className="text-ink-secondary mt-3 text-xs leading-6">查询更多战绩需要读取当前客户端的登录授权令牌，并仅发送给当前区服的 Riot 战绩服务器。该令牌属于敏感登录信息；不会写入磁盘、传给页面或发送到第三方。</p><p className="text-gold-400 mt-2 break-all text-xs">{cloudRoute?`${cloudRoute.platform} · ${cloudRoute.host}`:cloudError||"正在识别当前区服…"}</p><p className="text-ink-muted mt-3 text-[10px]">授权后默认读取最近 100 场，每页 10 场，可继续读取最多 500 场。实际数量由服务器提供；此授权仅适用于本功能，可随时关闭。</p><div className="mt-4 flex justify-end gap-3"><button onClick={()=>setCloudDialog(false)} className="text-ink-muted cursor-pointer text-xs">取消</button><button disabled={!cloudRoute} onClick={()=>{if(cloudRoute)localStorage.setItem("zushi:sgp-consent-host",cloudRoute.host);localStorage.removeItem("zushi:sgp-disabled");setUseSgp(true);setCloudDialog(false);setPage(0);}} className="bg-gold-400 text-charcoal-600 cursor-pointer rounded px-3 py-2 text-xs disabled:opacity-30">同意并查询</button></div></div></div>}
      {detailId && <div role="dialog" aria-modal="true" aria-label="对局详情" className="bg-charcoal-400 absolute inset-0 z-20 flex flex-col">
        <div className="border-border flex shrink-0 items-center gap-3 border-b px-4 py-3"><button onClick={() => {setDetailId(null); detailGeneration.current++;}} aria-label="关闭对局详情" className="text-ink cursor-pointer"><ArrowLeft size={17} /></button><span className="text-ink text-sm">对局详情</span><span className="text-ink-muted flex-1 text-xs">{detail ? `${queueName(detail,queues)} · ${dateText(detail)} · ${duration(detail.gameDuration)}` : ""}</span><button onClick={() => {setDetailId(null); detailGeneration.current++;}} aria-label="关闭详情" className="text-ink-muted cursor-pointer"><X size={16} /></button></div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {detailLoading && <p className="text-gold-400 text-sm">正在读取对局详情…</p>}
          {detailError && <p className="text-error text-xs">{detailError}</p>}
          {detail && <MatchPlayers game={detail} current={player?.puuid ?? ""} onChoose={choosePlayer} assets={assets}/>}
        </div>
      </div>}
    </div>
  );
}
function MatchPlayers({game,current,onChoose,assets}: {game:Json;current:string;onChoose:(player:ClientAccount)=>void;assets:GameAssets}) {
  const participants=(Array.isArray(game.participants)?game.participants:[]) as Json[];
  const arena=participants.some(p=>number(p.stats?.subteamId)>0);
  const groups=new Map<number,Json[]>();
  for(const p of participants){const id=number(arena?p.stats?.subteamId:p.teamId);groups.set(id,[...(groups.get(id)??[]),p]);}
  const maxDamage=Math.max(1,...participants.map(p=>number(p.stats?.totalDamageDealtToChampions)));
  return <div className="space-y-4"><p className="text-ink-muted text-xs">点击玩家名字查询战绩；鼠标停在装备和技能上可查看名称。</p>{[...groups.entries()].sort(([a],[b])=>a-b).map(([teamId,members],index)=>{
    const team=((game.teams??[]) as Json[]).find(t=>number(t.teamId)===teamId)??{};
    const kills=members.reduce((sum,p)=>sum+number(p.stats?.kills),0);
    const gold=members.reduce((sum,p)=>sum+number(p.stats?.goldEarned),0);
    const teamResult=team.win===true||team.win==="Win"?"胜利":team.win===false||team.win==="Fail"?"失败":members.some(p=>matchResult(game,p)==="win")?"胜利":members.some(p=>matchResult(game,p)==="loss")?"失败":members.some(p=>matchResult(game,p)==="remake")?"重开":"结果未知";
    const objectives=team.objectives;
    const objective=(name:string,field:string)=>objectives?.[name]?.kills??team[field];
    const placement=number(members[0]?.stats?.subteamPlacement);
    return <section key={teamId} className="border-border overflow-hidden rounded-lg border">
      <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs ${index%2===0?"bg-sky-500/10 text-sky-300":"bg-rose-500/10 text-rose-300"}`}><strong>{arena?`小队 ${teamId}${placement?` · 第 ${placement} 名`:""}`:teamId===100?"蓝色方":teamId===200?"红色方":`队伍 ${teamId}`} · {teamResult}</strong><span>{kills} 击杀 · 金币 {(gold/1000).toFixed(1)}k</span>{!arena&&<span className="text-ink-muted text-[10px]">{[["推塔",objective("tower","towerKills")],["小龙",objective("dragon","dragonKills")],["大龙",objective("baron","baronKills")]].filter(([,v])=>v!==undefined).map(([name,v])=>`${name} ${v}`).join(" · ")}</span>}</div>
      <div className="divide-border divide-y">{members.map(p=>{
        const identity=((game.participantIdentities??[]) as Json[]).find(i=>number(i.participantId)===number(p.participantId))?.player??{};
        const stats=p.stats??{};const name=identity.gameName||identity.summonerName||"未知玩家";
        const account:ClientAccount={puuid:identity.puuid||"",summonerId:number(identity.summonerId),gameName:name,tagLine:identity.tagLine||"",displayName:name,profileIconId:number(identity.profileIcon),level:0};
        const damage=number(stats.totalDamageDealtToChampions);const cs=number(stats.totalMinionsKilled)+number(stats.neutralMinionsKilled);
        const participation=kills?Math.round((number(stats.kills)+number(stats.assists))/kills*100):0;
        return <div key={p.participantId} className={`flex flex-wrap items-center gap-3 px-3 py-3 ${identity.puuid===current?"bg-gold-400/10":"bg-charcoal-500"}`}>
          <Avatar id={number(p.championId)}/><div className="min-w-0 flex-1 basis-28"><button disabled={!account.puuid} onClick={()=>onChoose(account)} className="text-ink hover:text-gold-400 max-w-full cursor-pointer truncate text-xs disabled:cursor-default">{accountName(account)}{identity.puuid===current?" ★":""}</button><p className="text-ink-muted mt-1 text-[10px]">{championInfo(number(p.championId))?.chineseName??`英雄 ${p.championId}`} · 参团 {participation}%</p></div>
          <div className="w-20 shrink-0 text-center"><p className="text-ink text-xs tabular-nums">{number(stats.kills)} / {number(stats.deaths)} / {number(stats.assists)}</p><p className="text-ink-muted mt-1 text-[10px]">补刀 {cs} · {(cs/Math.max(1,number(game.gameDuration)/60)).toFixed(1)}/分</p></div>
          <div className="w-24 shrink-0"><p className="text-ink text-right text-[10px]">伤害 {(damage/1000).toFixed(1)}k</p><div className="bg-charcoal-300 mt-1 h-1 rounded"><div className={`h-full rounded ${index%2===0?"bg-sky-400":"bg-rose-400"}`} style={{width:`${damage/maxDamage*100}%`}}/></div><p className="text-ink-muted mt-1 text-right text-[10px]">金币 {(number(stats.goldEarned)/1000).toFixed(1)}k</p></div>
          <Loadout participant={p} assets={assets}/>
        </div>;
      })}</div>
    </section>;
  })}</div>;
}
