import { localize } from "../i18n";
import { Crosshair, UserRound } from "lucide-react";
import { accountName, type ClientSnapshot } from "../hooks/useLeagueClient";
import { championCatalog } from "../lib/championCatalog";
const phases: Record<string, string> = {
  Lobby: "大厅",
  Matchmaking: "匹配中",
  ReadyCheck: "等待确认",
  ChampSelect: "选择英雄",
  GameStart: "游戏启动中",
  InProgress: "游戏中",
  WaitingForStats: "等待战绩",
  PreEndOfGame: "对局结束",
  EndOfGame: "结算",
  Reconnect: "等待重连",
  None: "客户端就绪",
};
interface Props {
  snapshot: ClientSnapshot;
  autoLocate: boolean;
  onAutoLocateChange: (value: boolean) => void;
  onLocate: (id: number) => void;
}
export default function ClientConnectionBar({
  snapshot: s,
  autoLocate,
  onAutoLocateChange,
  onLocate,
}: Props) {
  const champion = championCatalog.find((c) => Number(c.key) === s.championId);
  return (
    <div className="border-border bg-charcoal-500/40 flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2 text-xs">
      <UserRound size={14} className={s.connected ? "text-success" : "text-ink-muted"} />
      <span className="text-ink">
        {localize(s.account ? accountName(s.account) : "英雄联盟客户端")}
      </span>
      <span className="text-ink-muted min-w-0 flex-1 truncate" title={localize(s.error ?? "")}>
        {localize(
          s.connected
            ? `${phases[s.phase] || "客户端已连接"}${champion ? ` · ${champion.chineseName}` : ""}`
            : s.error || "正在连接客户端…"
        )}
      </span>
      <label className="text-ink-muted flex cursor-pointer items-center gap-1.5">
        <input
          type="checkbox"
          checked={autoLocate}
          onChange={(e) => onAutoLocateChange(e.target.checked)}
          className="accent-gold-400"
        />
        {localize("自动定位英雄")}
      </label>
      <button
        onClick={() => onLocate(s.championId)}
        disabled={!champion}
        className="text-gold-400 flex cursor-pointer items-center gap-1 disabled:cursor-default disabled:opacity-30"
      >
        <Crosshair size={13} />
        {localize("定位皮肤")}
      </button>
    </div>
  );
}
