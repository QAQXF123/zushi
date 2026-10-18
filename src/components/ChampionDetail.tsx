import { localize } from "../i18n";
import CachedArt from "./CachedArt";
import { ArrowLeft, Download, Check, Loader2 } from "lucide-react";
import { useSkinData, skinDownloadUrl, isSkinAvailable, getSplashNum } from "../hooks/useSkinData";
import { splashUrl, championAvatar } from "../hooks/useChampions";
import type { Champion, Skin, Chroma, SkinGroup } from "../types";

interface ChampionDetailProps {
  champion: Champion;
  onBack: () => void;
  isDownloaded: (championName: string, skinName: string) => boolean;
  isQueued: (championName: string, skinName: string) => boolean;
  onDownload: (url: string, championName: string, skinName: string) => void;
  onDownloadAll: (items: { url: string; championName: string; skinName: string }[]) => void;
}

function SkinSplash({ skin }: { skin: Skin }) {
  return (
    <CachedArt
      src={splashUrl(skin.championId, getSplashNum(skin))}
      alt={skin.name}
      className="h-full w-full transition-transform duration-300 group-hover:scale-105"
    />
  );
}

function ChromaSwatch({ chroma, available }: { chroma: Chroma; available: boolean }) {
  const [c1, c2] = chroma.colors;
  const bg = !c1 ? undefined : c2 ? `linear-gradient(135deg, ${c1} 0% 50%, ${c2} 50% 100%)` : c1;

  return (
    <div
      title={localize(`${chroma.name}${!available ? " (not available)" : ""}`)}
      className={[
        "h-5 w-5 shrink-0 rounded-sm ring-1 transition-all",
        available ? "ring-charcoal-50/30" : "ring-charcoal-50/10 opacity-30",
      ].join(" ")}
      style={{ background: bg ?? "var(--color-charcoal-400, #2a2a2a)" }}
    />
  );
}

function SkinCard({
  group,
  downloadKeyState,
  onDownloadGroup,
}: {
  group: SkinGroup;
  downloadKeyState: (skin: Skin) => {
    downloaded: boolean;
    isDownloading: boolean;
    available: boolean;
    url: string | null;
  };
  onDownloadGroup: (group: SkinGroup) => void;
}) {
  const baseState = downloadKeyState(group.base);
  const availableStates = [group.base, ...group.chromas]
    .map(downloadKeyState)
    .filter((state) => state.available);
  const groupDownloaded =
    availableStates.length > 0 && availableStates.every((state) => state.downloaded);
  const groupQueued = availableStates.some((state) => state.isDownloading);

  return (
    <div
      className={[
        "group bg-charcoal-500 relative overflow-hidden rounded border transition-colors",
        baseState.available
          ? "border-charcoal-50/20 hover:border-gold-400/60"
          : "border-charcoal-50/10 opacity-50",
      ].join(" ")}
    >
      <div className="bg-charcoal-600 relative aspect-video overflow-hidden">
        <SkinSplash skin={group.base} />

        <div className="absolute top-2 right-2 z-10">
          {localize(
            groupQueued ? (
              <span
                className="bg-gold-400/90 flex h-7 w-7 items-center justify-center rounded-full shadow-lg"
                title={localize("Queued / downloading")}
              >
                <Loader2 size={14} strokeWidth={2} className="animate-spin text-white" />
              </span>
            ) : groupDownloaded ? (
              <span className="bg-success/90 flex h-7 w-7 items-center justify-center rounded-full border border-white/20 shadow-lg">
                <Check size={14} strokeWidth={2.5} className="text-white" />
              </span>
            ) : baseState.available ? (
              <button
                onClick={() => onDownloadGroup(group)}
                className="bg-charcoal-600/80 hover:bg-gold-400 hover:text-charcoal-600 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-white opacity-0 shadow-lg transition-colors group-hover:opacity-100"
                title={localize(
                  group.chromas.length > 0
                    ? `Download skin and ${group.chromas.length} chroma${group.chromas.length === 1 ? "" : "s"}`
                    : "Download"
                )}
              >
                <Download size={14} strokeWidth={2} />
              </button>
            ) : null
          )}
        </div>

        {localize(
          !baseState.available && (
            <div className="bg-charcoal-600/60 absolute inset-0 flex items-center justify-center">
              <span className="text-[10px] font-medium tracking-wide text-white/60 uppercase select-none">
                {localize("Not available")}
              </span>
            </div>
          )
        )}
      </div>

      <div className="px-3 py-2">
        <p className="text-ink line-clamp-2 text-xs leading-snug">{localize(group.base.name)}</p>
        {localize(
          group.chromas.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {localize(
                group.chromas.map((chroma) => {
                  const cs = downloadKeyState(chroma);
                  return <ChromaSwatch key={chroma.id} chroma={chroma} available={cs.available} />;
                })
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}

export default function ChampionDetail({
  champion,
  onBack,
  isDownloaded,
  isQueued,
  onDownload,
  onDownloadAll,
}: ChampionDetailProps) {
  const { skins, groups, loading, error } = useSkinData(champion);

  const notDownloaded = skins.filter(
    (s) =>
      !isDownloaded(s.championName, s.name) &&
      !isQueued(s.championName, s.name) &&
      isSkinAvailable(s)
  );
  const allDownloaded = notDownloaded.length === 0 && skins.length > 0;

  const downloadKeyState = (skin: Skin) => {
    return {
      downloaded: isDownloaded(skin.championName, skin.name),
      isDownloading: isQueued(skin.championName, skin.name),
      available: isSkinAvailable(skin),
      url: skinDownloadUrl(skin),
    };
  };

  const handleDownloadAll = () => {
    const items: { url: string; championName: string; skinName: string }[] = [];
    for (const s of notDownloaded) {
      const url = skinDownloadUrl(s);
      if (url) {
        items.push({ url, championName: s.championName, skinName: s.name });
      }
    }
    if (items.length > 0) onDownloadAll(items);
  };

  const handleDownloadGroup = (group: SkinGroup) => {
    const items: { url: string; championName: string; skinName: string }[] = [];
    const candidates: Skin[] = [group.base, ...group.chromas];
    for (const s of candidates) {
      if (isDownloaded(s.championName, s.name) || isQueued(s.championName, s.name)) continue;
      const url = skinDownloadUrl(s);
      if (!url) continue;
      items.push({ url, championName: s.championName, skinName: s.name });
    }
    if (items.length === 1) {
      onDownload(items[0].url, items[0].championName, items[0].skinName);
    } else if (items.length > 1) {
      onDownloadAll(items);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
        <button
          onClick={onBack}
          className="hover:bg-charcoal-200 text-ink-muted hover:text-ink -ml-1 flex h-8 w-8 cursor-pointer items-center justify-center rounded-md transition-colors"
        >
          <ArrowLeft size={20} strokeWidth={1.5} />
        </button>

        <img
          src={championAvatar(champion.id)}
          alt={localize(champion.name)}
          className="h-7 w-7 rounded-sm"
          draggable={false}
        />

        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-ink truncate text-sm font-medium">{localize(champion.name)}</span>
          <span className="text-ink-muted hidden truncate text-xs sm:inline">
            {localize(champion.title)}
          </span>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          {localize(
            !loading && (
              <span className="text-ink-muted text-[11px] tabular-nums select-none">
                {localize(groups.length)} {localize(groups.length === 1 ? "skin" : "skins")}
              </span>
            )
          )}

          {localize(
            !loading && skins.length > 0 && !allDownloaded && (
              <button
                onClick={handleDownloadAll}
                disabled={notDownloaded.length === 0}
                className="bg-gold-400 text-charcoal-600 hover:bg-gold-300 flex cursor-pointer items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-40"
              >
                <Download size={13} strokeWidth={2} />
                {localize("Download All")}
              </button>
            )
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {localize(
          loading ? (
            <div className="flex h-32 items-center justify-center">
              <span className="text-ink-muted text-sm">{localize("Loading skins...")}</span>
            </div>
          ) : error ? (
            <div className="flex h-32 flex-col items-center justify-center gap-1">
              <span className="text-error text-sm">{localize("Failed to load skin data")}</span>
              <span className="text-ink-muted text-xs">{localize(error)}</span>
            </div>
          ) : groups.length === 0 ? (
            <div className="flex h-32 items-center justify-center">
              <span className="text-ink-muted text-sm">{localize("No skins available")}</span>
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-3">
              {localize(
                groups.map((group) => (
                  <SkinCard
                    key={group.base.id}
                    group={group}
                    downloadKeyState={downloadKeyState}
                    onDownloadGroup={handleDownloadGroup}
                  />
                ))
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}
