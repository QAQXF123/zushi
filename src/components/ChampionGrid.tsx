import ChampionFilters from "./ChampionFilters";
import { championDisplayName } from "../lib/championFilters";
import { useChampions, championAvatar } from "../hooks/useChampions";
import type { Champion } from "../types";

interface ChampionGridProps {
  onSelect: (champion: Champion) => void;
}

export default function ChampionGrid({ onSelect }: ChampionGridProps) {
  const { champions, total, loading, error, search, setSearch, position, setPosition } = useChampions();

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-ink-muted text-sm">Loading champions...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <span className="text-error text-sm">Failed to load champion data</span>
        <span className="text-ink-muted text-xs">{error}</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ChampionFilters search={search} onSearchChange={setSearch} position={position} onPositionChange={setPosition} />
      <span className="text-ink-muted px-4 pt-2 text-[11px]">{champions.length} / {total} 位英雄</span>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {champions.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-0.5">
            {champions.map((champ) => (
              <button
                key={champ.key}
                onClick={() => onSelect(champ)}
                className="group flex cursor-pointer flex-col items-center gap-0.5 rounded-sm p-1.5 transition-transform duration-100 active:scale-[0.96]"
                title={`${championDisplayName(champ)} · ${champ.name}, ${champ.title}`}
                data-champion={champ.name}
              >
                <div className="border-charcoal-50/30 group-hover:border-gold-400 bg-charcoal-500 h-14 w-14 overflow-hidden rounded-sm border transition-colors duration-150">
                  <img
                    src={championAvatar(champ.id)}
                    alt={champ.name}
                    className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-105"
                    loading="lazy"
                    draggable={false}
                  />
                </div>
                <span className="text-ink-muted group-hover:text-gold-300 w-full truncate text-center text-[10px] leading-tight transition-colors select-none">
                  {championDisplayName(champ)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex h-32 items-center justify-center">
            <span className="text-ink-muted text-sm">No champions found</span>
          </div>
        )}
      </div>
    </div>
  );
}
