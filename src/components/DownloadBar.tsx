import { Loader2 } from "lucide-react";

interface DownloadBarProps {
  downloading: string | null;
  pendingCount: number;
  activeCount: number;
}

export default function DownloadBar({ downloading, pendingCount, activeCount }: DownloadBarProps) {
  if (!downloading) return null;
  return (
    <div className="border-border bg-charcoal-600 flex items-center gap-3 border-t px-4 py-2">
      <Loader2 size={14} className="text-gold-400 shrink-0 animate-spin" />
      <span className="text-ink truncate text-sm font-medium">{activeCount > 1 ? `Downloading ${activeCount} skins...` : `Downloading ${downloading}...`}</span>
      {pendingCount > activeCount && (
        <span className="text-ink-muted ml-auto shrink-0 text-xs">{pendingCount - activeCount} queued</span>
      )}
    </div>
  );
}
