import { localize } from "../i18n";
import { useState } from "react";
import { Shuffle, LoaderCircle } from "lucide-react";
import type { RandomSkinPlan } from "../lib/randomSkins";
import { qualityLabels } from "../lib/randomSkins";
import { championDisplayName } from "../lib/championFilters";
interface Props {
  busy: boolean;
  active: boolean;
  count: number;
  plan: RandomSkinPlan | null;
  excluded: string;
  onExclude: (value: string) => void;
  onApply: () => void;
}
export default function RandomSkinBar({
  busy,
  active,
  count,
  plan,
  excluded,
  onExclude,
  onApply,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-border bg-gold-400/5 shrink-0 border-b px-4 py-2.5">
      <div className="flex items-center gap-3">
        <Shuffle size={16} className="text-gold-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-ink text-xs font-medium">{localize("全英雄优质皮肤随机应用")}</p>
          <p className="text-ink-muted mt-1 text-[10px]">
            {localize("每个英雄一个 · 优先传说/终极，再选史诗/神话 · 跳过原皮、炫彩及未知品质")}
          </p>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-ink-muted hover:text-gold-400 shrink-0 cursor-pointer text-[10px]"
        >
          {localize(expanded ? "收起" : "选择规则 / 排除名单")}
        </button>
        <button
          disabled={busy || active || !count}
          onClick={onApply}
          title={localize(
            active
              ? "请先点击 Stop，再随机并应用新的皮肤"
              : "随机选择全部已下载英雄的优质皮肤，并直接启动应用"
          )}
          className="bg-gold-400 text-charcoal-600 flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium disabled:cursor-default disabled:opacity-40"
        >
          {localize(
            busy ? <LoaderCircle size={13} className="animate-spin" /> : <Shuffle size={13} />
          )}{" "}
          {localize(busy ? "正在选择…" : "一键随机并应用")}
        </button>
      </div>
      {localize(
        plan && (
          <p className="text-gold-400 mt-1.5 text-[10px]">
            {localize("已为 ")}
            {localize(plan.chosen.length)}
            {localize(" 位英雄选择皮肤")}
            {localize(
              plan.skipped.length
                ? ` · ${plan.skipped.length} 位没有符合条件的已下载皮肤，已跳过`
                : ""
            )}
            {localize("。")}
            {localize(active ? "正在应用，准备完成后保持软件运行。" : "选择已保存。")}
          </p>
        )
      )}
      {localize(
        expanded && (
          <div className="mt-2 space-y-2 text-[10px]">
            <p className="text-ink-muted">
              {localize(
                "品质依据客户端元数据，不是玩家评分。优先选传说、终极、超凡和殿堂皮肤；没有时优先选特效主题史诗/神话。排除部分老版传说皮肤。无法确认品质时跳过，不用普通皮肤补齐。再次随机尽量避开上一次的选择。"
              )}
            </p>
            <label className="text-ink-secondary block">
              {localize("排除你不喜欢的皮肤或系列（英文名称关键词，逗号分隔）")}
              <input
                value={excluded}
                onChange={(e) => onExclude(e.target.value)}
                placeholder={localize("例如：PROJECT:, Battle Boss")}
                className="border-border bg-charcoal-500 text-ink mt-1 w-full rounded border px-2 py-1.5 outline-none"
              />
            </label>
            {localize(
              plan && (
                <div className="bg-charcoal-500 max-h-36 overflow-y-auto rounded p-2">
                  {localize(
                    plan.chosen.map((row) => (
                      <p key={row.champion} className="text-ink-secondary py-0.5">
                        {localize(championDisplayName(row.champion))}
                        {localize("：")}
                        {localize(row.skin)}{" "}
                        <span className="text-gold-400">{localize(qualityLabels[row.rarity])}</span>{" "}
                        <span className="text-ink-muted">
                          {localize("（候选 ")}
                          {localize(row.pool)}
                          {localize(" 个）")}
                        </span>
                      </p>
                    ))
                  )}
                  {localize(
                    plan.skipped.length > 0 && (
                      <p className="text-ink-muted mt-1">
                        {localize("跳过：")}
                        {localize(plan.skipped.map(championDisplayName).join("、"))}
                      </p>
                    )
                  )}
                </div>
              )
            )}
          </div>
        )
      )}
    </div>
  );
}
