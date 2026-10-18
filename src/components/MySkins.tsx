import { prefetchChampionArtwork } from "../lib/artworkPrefetch";
import CachedArt from "./CachedArt";
import { localize } from "../i18n";
import { memo, useState, useEffect, useMemo } from "react";
import { Layers, Check, Info, X, ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { splashUrl, findChampionByName, championAvatar } from "../hooks/useChampions";
import {
  lookupSplashNum,
  lookupChromaInfo,
  ensureChromaInfo,
  ensureSkinIds,
  skinMetadataReady,
} from "../hooks/useSkinData";
import { downloadedChampionIndex, groupDownloadedSkins } from "../lib/downloadedSkins";
import {
  championDisplayName,
  championMatchesSearch,
  championPositions,
  type Position,
} from "../lib/championFilters";
import ChampionFilters from "./ChampionFilters";
import type { DownloadedSkin } from "../types";

type Selection = Record<string, string>;
interface MySkinsProps {
  focusChampion?: { name: string; stamp: number } | null;
  downloads: DownloadedSkin[];
  patcherActive: boolean;
  selection: Selection;
  onSelectionChange: (selection: Selection) => void;
  onDelete: (championName: string, skinName: string) => Promise<void>;
}

function useSkinMetadata(): boolean {
  const [ready, setReady] = useState(skinMetadataReady);
  useEffect(() => {
    let cancelled = false;
    Promise.all([ensureSkinIds(), ensureChromaInfo()])
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return ready;
}

const SkinThumb = memo(function SkinThumb({
  championName,
  skinName,
}: {
  championName: string;
  skinName: string;
}) {
  const champ = findChampionByName(championName),
    num = lookupSplashNum(skinName);
  if (!champ || num === null) return <div className="bg-charcoal-600 h-full w-full" />;
  return <CachedArt src={splashUrl(champ.id, num)} alt={skinName} className="h-full w-full" />;
});

function ChampAvatar({ championName }: { championName: string }) {
  const [failed, setFailed] = useState(false);
  const champ = findChampionByName(championName);

  if (!champ || failed) {
    return (
      <div className="bg-charcoal-500 text-ink-muted flex h-8 w-8 items-center justify-center rounded text-[10px]">
        {localize(championName.charAt(0))}
      </div>
    );
  }

  return (
    <img
      src={championAvatar(champ.id)}
      alt={localize(championName)}
      className="h-8 w-8 rounded object-cover"
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

export default function MySkins(props: MySkinsProps) {
  const { downloads, selection } = props;
  const [champion, setChampion] = useState<string | null>(props.focusChampion?.name ?? null);
  useEffect(() => {
    if (props.focusChampion) setChampion(props.focusChampion.name);
  }, [props.focusChampion]);
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState<Position | "all">("all");
  const index = useMemo(() => downloadedChampionIndex(downloads), [downloads]);
  const heroes = useMemo(
    () =>
      [...index.entries()].filter(
        ([name]) =>
          championMatchesSearch(name, search) &&
          (position === "all" || championPositions(name).includes(position))
      ),
    [index, search, position]
  );

  if (champion) {
    return (
      <ChampionSkins
        key={champion}
        {...props}
        champion={champion}
        skins={index.get(champion) ?? []}
        onBack={() => setChampion(null)}
      />
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex shrink-0 items-center justify-between border-b px-4 py-3">
        <span className="text-ink text-sm">{localize("我的皮肤")}</span>
        <span className="text-ink-muted text-xs tabular-nums">
          {localize(index.size)}
          {localize(" 位英雄 · ")}
          {localize(downloads.length)}
          {localize(" 个皮肤及炫彩")}
        </span>
      </div>
      <ChampionFilters
        search={search}
        onSearchChange={setSearch}
        position={position}
        onPositionChange={setPosition}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {localize(
          heroes.length === 0 ? (
            <div className="text-ink-muted flex h-40 flex-col items-center justify-center gap-3">
              <Layers size={24} />
              <span className="text-sm">
                {localize(downloads.length === 0 ? "还没有下载皮肤" : "没有符合筛选条件的英雄")}
              </span>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {localize(
                heroes.map(([name, skins]) => (
                  <button
                    key={name}
                    onPointerEnter={() => prefetchChampionArtwork(name)}
                    onFocus={() => prefetchChampionArtwork(name)}
                    onClick={() => setChampion(name)}
                    data-champion={name}
                    className="border-border bg-charcoal-500 hover:border-gold-400/60 flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-left transition-colors"
                  >
                    <ChampAvatar championName={name} />
                    <div className="min-w-0 flex-1">
                      <p className="text-ink truncate text-sm font-medium">
                        {localize(championDisplayName(name))}
                      </p>
                      <p className="text-ink-muted truncate text-[10px]">
                        {localize(findChampionByName(name)?.title ?? "")}
                      </p>
                      <p className="text-ink-muted mt-1 text-[10px]">
                        {localize(skins.length)}
                        {localize(" 个皮肤及炫彩")}
                      </p>
                    </div>
                    {localize(
                      selection[name] && (
                        <Check
                          size={14}
                          className="text-gold-400 shrink-0"
                          aria-label={localize("已选皮肤")}
                        />
                      )
                    )}
                  </button>
                ))
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}

function ChampionSkins({
  patcherActive,
  selection,
  onSelectionChange,
  onDelete,
  champion,
  skins,
  onBack,
}: MySkinsProps & { champion: string; skins: DownloadedSkin[]; onBack: () => void }) {
  const metadataReady = useSkinMetadata();
  const groups = useMemo(() => {
    void metadataReady;
    return groupDownloadedSkins(skins, lookupChromaInfo);
  }, [skins, metadataReady]);
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(groups.length / 24));
  const currentPage = Math.min(page, pages - 1);
  const visibleGroups = groups.slice(currentPage * 24, (currentPage + 1) * 24);
  const selectedSkin = selection[champion];
  const toggleSkin = (championName: string, skinName: string) => {
    if (patcherActive) return;
    if (selection[championName] === skinName) {
      const next = { ...selection };
      delete next[championName];
      onSelectionChange(next);
    } else {
      onSelectionChange({ ...selection, [championName]: skinName });
    }
  };

  const handleDelete = async (championName: string, skinName: string) => {
    if (patcherActive) return;
    // Also deselect if this skin was selected
    if (selection[championName] === skinName) {
      const next = { ...selection };
      delete next[championName];
      onSelectionChange(next);
    }
    await onDelete(championName, skinName);
  };

  const handleDeleteGroup = async (championName: string, skinNames: string[]) => {
    if (patcherActive || skinNames.length === 0) return;
    if (skinNames.includes(selection[championName])) {
      const next = { ...selection };
      delete next[championName];
      onSelectionChange(next);
    }
    await Promise.all(skinNames.map((n) => onDelete(championName, n)));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <button
          onClick={onBack}
          aria-label={localize("返回英雄列表")}
          className="text-ink-muted hover:text-ink flex h-8 w-8 cursor-pointer items-center justify-center rounded-md"
        >
          <ArrowLeft size={18} />
        </button>
        <ChampAvatar championName={champion} />
        <span className="text-ink text-sm font-medium">
          {localize(championDisplayName(champion))}
        </span>
        <span className="text-ink-muted text-xs">
          {localize(findChampionByName(champion)?.title ?? "")}
        </span>
        <span className="text-ink-muted ml-auto text-xs">
          {localize(skins.length)}
          {localize(" 个皮肤及炫彩")}
        </span>
      </div>
      <div className="border-gold-400/15 bg-gold-400/8 mx-4 mt-3 flex items-start gap-2 rounded-lg border px-3 py-2">
        <Info size={14} className="text-gold-400 mt-0.5 shrink-0" />
        <p className="text-ink-secondary text-xs">
          {localize("在此选择皮肤，再点击右下角 Apply。英雄联盟选人界面保持默认皮肤。")}
          {localize(patcherActive && " 更换皮肤前请先点击 Stop。")}
        </p>
      </div>
      {localize(
        selectedSkin && (
          <p className="text-gold-400 px-4 pt-2 text-xs">
            {localize("已选：")}
            {localize(selectedSkin)}
          </p>
        )
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-wrap items-start gap-3">
          {localize(
            visibleGroups.map((group) => {
              const baseSelected = selectedSkin === group.baseSkinName;
              const selectedChroma = group.chromas.find((c) => c.dl.skin_name === selectedSkin);
              const anySelected = baseSelected || !!selectedChroma;
              const baseClickable = !patcherActive && group.base !== null;

              const hasChromas = group.chromas.length > 0;
              return (
                <div
                  key={group.baseSkinName}
                  className={
                    hasChromas
                      ? "bg-charcoal-500/70 border-charcoal-300/25 rounded-md border p-1.5"
                      : ""
                  }
                >
                  <div className="relative">
                    <button
                      onClick={() => {
                        if (!baseClickable || !group.base) return;
                        toggleSkin(group.base.champion_name, group.base.skin_name);
                      }}
                      disabled={!baseClickable}
                      className={[
                        "relative h-24 w-32 overflow-hidden rounded transition-all",
                        patcherActive
                          ? "cursor-default opacity-50"
                          : group.base
                            ? "cursor-pointer"
                            : "cursor-default",
                        anySelected
                          ? "ring-gold-400 ring-offset-charcoal-400 ring-2 ring-offset-1"
                          : "ring-charcoal-50/20 hover:ring-charcoal-50/40 ring-1",
                        !group.base && "opacity-70",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      title={localize(
                        group.base
                          ? group.baseSkinName
                          : `${group.baseSkinName} (base not downloaded)`
                      )}
                    >
                      {localize(
                        metadataReady && (
                          <SkinThumb championName={champion} skinName={group.baseSkinName} />
                        )
                      )}

                      {localize(
                        baseSelected && (
                          <div className="bg-gold-400 absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full border border-white/30 shadow-sm">
                            <Check size={11} strokeWidth={3} className="text-charcoal-600" />
                          </div>
                        )
                      )}
                      {localize(
                        selectedChroma && (
                          <div
                            className="absolute top-1 right-1 h-5 w-5 rounded-full border-2 border-white shadow-sm"
                            style={{
                              background: selectedChroma.colors[1]
                                ? `linear-gradient(135deg, ${selectedChroma.colors[0]} 0% 50%, ${selectedChroma.colors[1]} 50% 100%)`
                                : (selectedChroma.colors[0] ?? "var(--color-gold-400)"),
                            }}
                            title={localize(`Chroma: ${selectedChroma.dl.skin_name}`)}
                          />
                        )
                      )}

                      <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 via-black/40 to-transparent px-1.5 pt-4 pb-1">
                        <p className="line-clamp-2 text-[10px] leading-tight text-white/90">
                          {localize(group.baseSkinName)}
                        </p>
                      </div>
                    </button>

                    {localize(
                      !patcherActive && group.base && (
                        <button
                          onClick={() => {
                            const names: string[] = [];
                            if (group.base) names.push(group.base.skin_name);
                            for (const c of group.chromas) names.push(c.dl.skin_name);
                            handleDeleteGroup(champion, names);
                          }}
                          className="bg-charcoal-500 hover:bg-error text-ink-muted absolute top-1 left-1 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full shadow transition-colors hover:text-white"
                          title={localize(
                            group.chromas.length > 0
                              ? `Delete skin and ${group.chromas.length} chroma${group.chromas.length === 1 ? "" : "s"}`
                              : "Delete skin"
                          )}
                        >
                          <X size={10} strokeWidth={2.5} />
                        </button>
                      )
                    )}
                  </div>

                  {localize(
                    group.chromas.length > 0 && (
                      <div className="mt-1 flex w-32 flex-wrap items-center gap-1">
                        {localize(
                          group.chromas.map((c) => {
                            const isSel = selectedSkin === c.dl.skin_name;
                            const bg = c.colors[1]
                              ? `linear-gradient(135deg, ${c.colors[0]} 0% 50%, ${c.colors[1]} 50% 100%)`
                              : (c.colors[0] ?? undefined);
                            return (
                              <button
                                key={c.dl.skin_name}
                                onClick={() => toggleSkin(c.dl.champion_name, c.dl.skin_name)}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  handleDelete(c.dl.champion_name, c.dl.skin_name);
                                }}
                                disabled={patcherActive}
                                title={localize(`${c.dl.skin_name}\n(right-click to delete)`)}
                                className={[
                                  "ring-offset-charcoal-400 relative h-4 w-4 shrink-0 rounded-sm transition-all",
                                  patcherActive ? "cursor-default opacity-50" : "cursor-pointer",
                                  isSel
                                    ? "ring-gold-400 ring-2 ring-offset-1"
                                    : "ring-charcoal-50/30 hover:ring-charcoal-50/60 ring-1",
                                ].join(" ")}
                                style={{
                                  background: bg ?? "var(--color-charcoal-300, #3a3a3a)",
                                }}
                              >
                                {localize(
                                  isSel && (
                                    <Check
                                      size={9}
                                      strokeWidth={3}
                                      className="absolute inset-0 m-auto text-white drop-shadow"
                                    />
                                  )
                                )}
                              </button>
                            );
                          })
                        )}
                      </div>
                    )
                  )}
                </div>
              );
            })
          )}
        </div>
        {localize(
          groups.length === 0 && (
            <p className="text-ink-muted py-10 text-center text-sm">
              {localize("该英雄没有剩余皮肤")}
            </p>
          )
        )}
      </div>
      {localize(
        pages > 1 && (
          <div className="border-border flex shrink-0 items-center justify-center gap-4 border-t px-4 py-2">
            <button
              onClick={() => setPage(currentPage - 1)}
              disabled={currentPage === 0}
              aria-label={localize("上一页")}
              className="text-ink hover:text-gold-400 cursor-pointer disabled:cursor-default disabled:opacity-30"
            >
              <ChevronLeft size={18} />
            </button>
            <span className="text-ink-muted text-xs">
              {localize(currentPage + 1)}
              {localize(" / ")}
              {localize(pages)}
            </span>
            <button
              onClick={() => setPage(currentPage + 1)}
              disabled={currentPage === pages - 1}
              aria-label={localize("下一页")}
              className="text-ink hover:text-gold-400 cursor-pointer disabled:cursor-default disabled:opacity-30"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        )
      )}
    </div>
  );
}
