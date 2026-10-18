import { localize } from "../i18n";
import { Search } from "lucide-react";
import { POSITION_OPTIONS, type Position } from "../lib/championFilters";

interface Props {
  search: string;
  onSearchChange: (value: string) => void;
  position: Position | "all";
  onPositionChange: (value: Position | "all") => void;
}
export default function ChampionFilters({
  search,
  onSearchChange,
  position,
  onPositionChange,
}: Props) {
  return (
    <div className="border-border flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
      <div className="relative max-w-72 min-w-44 flex-1">
        <Search
          size={14}
          className="text-ink-muted pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
        />
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={localize("搜索英雄中文名、称号或英文名")}
          aria-label={localize("搜索英雄")}
          className="bg-charcoal-500 border-border text-ink placeholder:text-ink-muted focus:border-gold-500/60 w-full rounded-md border py-1.5 pr-3 pl-8 text-xs outline-none"
        />
      </div>
      <div className="flex flex-wrap gap-1" aria-label={localize("位置筛选")}>
        {localize(
          POSITION_OPTIONS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => onPositionChange(id)}
              aria-pressed={position === id}
              className={`cursor-pointer rounded-md px-2.5 py-1.5 text-xs transition-colors ${position === id ? "bg-gold-400 text-charcoal-600" : "bg-charcoal-500 text-ink-muted hover:text-ink"}`}
            >
              {localize(label)}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
