import { localize } from "../i18n";
import { Download, LoaderCircle } from "lucide-react";
import type { LibraryProgress } from "../hooks/useLibraryDownload";
interface Props {
  progress: LibraryProgress;
  busy: boolean;
  count: number;
  onStart: () => void;
  onCancel: () => void;
}
export default function LibraryDownloadBar({ progress: p, busy, count, onStart, onCancel }: Props) {
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  const text =
    p.phase === "downloading"
      ? `正在下载全部皮肤：${mb(p.receivedBytes)} MB${p.totalBytes ? ` / ${mb(p.totalBytes)} MB` : ""}`
      : p.phase === "indexing"
        ? "正在校验仓库并读取皮肤索引…"
        : p.phase === "importing"
          ? `正在导入 ${p.current} / ${p.total} · 新增 ${p.imported} · 跳过已有 ${p.skipped}`
          : p.phase === "cancelling"
            ? "正在停止，已导入的皮肤会保留…"
            : p.phase === "done"
              ? `获取完成：新增 ${p.imported}，已有 ${p.skipped} 个皮肤及炫彩`
              : p.phase === "cancelled"
                ? "已停止，可再次点击继续获取，已有文件会跳过"
                : p.phase === "error"
                  ? `获取失败：${p.error}`
                  : `当前已下载 ${count} 个皮肤及炫彩，一次获取全部英雄，无需逐个点击`;
  const percent =
    p.phase === "importing" && p.total
      ? (p.current / p.total) * 100
      : p.phase === "downloading" && p.totalBytes
        ? (p.receivedBytes / p.totalBytes) * 100
        : null;
  return (
    <div className="border-border bg-charcoal-500/50 shrink-0 border-b px-4 py-3">
      <div className="flex items-center gap-3">
        <button
          onClick={onStart}
          disabled={busy}
          className="bg-gold-400 text-charcoal-600 flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-xs font-medium disabled:cursor-default disabled:opacity-60"
        >
          {localize(
            busy ? <LoaderCircle size={14} className="animate-spin" /> : <Download size={14} />
          )}
          {localize("一键获取全部皮肤")}
        </button>
        <p
          role="status"
          className={`min-w-0 flex-1 text-xs break-words ${p.phase === "error" ? "text-error" : "text-ink-muted"}`}
        >
          {localize(text)}
        </p>
        {localize(
          busy && (
            <button
              onClick={onCancel}
              disabled={p.phase === "cancelling"}
              className="text-ink-muted hover:text-ink shrink-0 cursor-pointer text-xs disabled:opacity-50"
            >
              {localize("停止获取")}
            </button>
          )
        )}
      </div>
      {localize(
        percent !== null && (
          <div className="bg-charcoal-300 mt-2 h-1 overflow-hidden rounded">
            <div
              className="bg-gold-400 h-full transition-all"
              style={{ width: `${Math.min(100, percent)}%` }}
            />
          </div>
        )
      )}
    </div>
  );
}
