import { clearArtwork } from "../lib/artwork";
import { localize, useLanguage, setLanguage, type Language } from "../i18n";
import { invoke } from "@tauri-apps/api/core";
import { useState, useEffect, useCallback } from "react";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { open } from "@tauri-apps/plugin-dialog";
import { Power, FolderOpen, Trash2, Loader2, HardDrive } from "lucide-react";
import {
  getSkinsDirSize,
  getWorkDirSize,
  getCustomsDirSize,
  clearAllSkins,
  clearWorkDir,
  clearAllCustoms,
} from "../lib/commands";
import Toast from "./Toast";

interface SettingsProps {
  gamePath: string | null;
  onPathChange: (path: string) => Promise<boolean>;
  patcherActive: boolean;
  onSkinsCleared: () => Promise<void>;
  onCustomsCleared: () => Promise<void>;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function Settings({
  gamePath,
  onPathChange,
  patcherActive,
  onSkinsCleared,
  onCustomsCleared,
}: SettingsProps) {
  const language = useLanguage();
  const [autoStart, setAutoStart] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(true);
  const [pathLoading, setPathLoading] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);

  // Cache state
  const [artSize, setArtSize] = useState(0);
  const [clearingArt, setClearingArt] = useState(false);
  const [skinsSize, setSkinsSize] = useState(0);
  const [workSize, setWorkSize] = useState(0);
  const [cacheLoading, setCacheLoading] = useState(true);
  const [customsSize, setCustomsSize] = useState(0);
  const [clearingContent, setClearingContent] = useState(false);
  const [clearingWork, setClearingWork] = useState(false);

  useEffect(() => {
    isEnabled()
      .then(setAutoStart)
      .catch(() => {})
      .finally(() => setAutoStartLoading(false));
  }, []);

  const refreshCache = useCallback(async () => {
    setCacheLoading(true);
    try {
      const [s, w, c, art] = await Promise.all([
        getSkinsDirSize(),
        getWorkDirSize(),
        getCustomsDirSize(),
        invoke<{ bytes: number }>("get_art_cache_info"),
      ]);
      setArtSize(art.bytes);
      setSkinsSize(s);
      setWorkSize(w);
      setCustomsSize(c);
    } catch {
      // ignore
    }
    setCacheLoading(false);
  }, []);

  useEffect(() => {
    refreshCache();
  }, [refreshCache]);

  const handleAutoStartToggle = async () => {
    setAutoStartLoading(true);
    try {
      if (autoStart) {
        await disable();
        setAutoStart(false);
      } else {
        await enable();
        setAutoStart(true);
      }
    } catch {
      // state stays unchanged
    } finally {
      setAutoStartLoading(false);
    }
  };

  const handleChangePath = async () => {
    setPathError(null);
    setPathLoading(true);
    try {
      const selected = await open({
        multiple: false,
        title: localize("Select League of Legends app"),
      });
      if (selected) {
        const valid = await onPathChange(selected as string);
        if (!valid) {
          setPathError(localize("Invalid game path: LeagueofLegends.app not found"));
        }
      }
    } catch {
      setPathError(localize("Failed to open file dialog."));
    } finally {
      setPathLoading(false);
    }
  };

  const handleClearContent = async () => {
    setClearingContent(true);
    try {
      await Promise.all([clearAllSkins(), clearAllCustoms()]);
      localStorage.removeItem("zushi_skin_selection");
      localStorage.removeItem("zushi_customs_enabled");
      await Promise.all([onSkinsCleared(), onCustomsCleared()]);
    } catch {
      // ignore
    }
    setClearingContent(false);
    await refreshCache();
  };

  const handleClearWork = async () => {
    setClearingWork(true);
    try {
      await clearWorkDir();
    } catch {
      // ignore
    }
    setClearingWork(false);
    await refreshCache();
  };

  const contentSize = skinsSize + customsSize;
  const totalSize = skinsSize + workSize + customsSize + artSize;

  return (
    <div className="h-full w-full overflow-y-auto p-5">
      {/* General */}
      <div className="pb-2">
        <span className="text-ink-muted text-[11px] font-medium tracking-wider uppercase select-none">
          {localize("General")}
        </span>
      </div>

      <div className="border-border divide-border divide-y rounded-lg border">
        <div className="flex items-center justify-between gap-4 px-4 py-3.5">
          <div>
            <p className="text-ink text-sm">{localize("界面语言")}</p>
            <p className="text-ink-muted mt-1 text-xs">
              {localize("立即切换界面语言，重启后保留选择")}
            </p>
          </div>
          <select
            aria-label={localize("界面语言")}
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
            className="bg-charcoal-500 border-border text-ink rounded border px-3 py-2 text-sm"
          >
            <option value="zh">简体中文</option>
            <option value="en">English</option>
          </select>
        </div>
        {/* Auto-start */}
        <div className="flex items-center justify-between px-4 py-3.5">
          <div className="flex items-center gap-3">
            <Power size={16} strokeWidth={1.5} className="text-ink-muted" />
            <div className="flex flex-col gap-0.5">
              <span className="text-ink text-sm">{localize("Launch at login")}</span>
              <span className="text-ink-muted text-xs">
                {localize("Start Zushi automatically when you log in")}
              </span>
            </div>
          </div>
          <button
            onClick={handleAutoStartToggle}
            disabled={autoStartLoading}
            aria-pressed={autoStart}
            className={[
              "relative h-6 w-10 shrink-0 cursor-pointer rounded-full transition-colors duration-200",
              "focus:outline-none disabled:cursor-not-allowed disabled:opacity-40",
              autoStart ? "bg-gold-400" : "bg-charcoal-100",
            ].join(" ")}
          >
            <span
              className={[
                "absolute top-1 left-1 h-4 w-4 rounded-full bg-white transition-transform duration-200",
                autoStart ? "translate-x-4" : "translate-x-0",
              ].join(" ")}
            />
          </button>
        </div>

        {/* Game path */}
        <div className="flex items-center justify-between gap-4 px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <FolderOpen size={16} strokeWidth={1.5} className="text-ink-muted shrink-0" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-ink text-sm">{localize("Game path")}</span>
              <span className="text-ink-muted truncate font-mono text-xs">
                {localize(gamePath ?? "Not set")}
              </span>
            </div>
          </div>
          <button
            onClick={handleChangePath}
            disabled={pathLoading}
            className="border-border text-ink-secondary hover:border-gold-400 hover:text-gold-400 shrink-0 cursor-pointer rounded-md border px-3.5 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {localize(pathLoading ? "Validating..." : "Change")}
          </button>
        </div>
      </div>

      {/* Storage */}
      <div className="mt-6 pb-2">
        <span className="text-ink-muted text-[11px] font-medium tracking-wider uppercase select-none">
          {localize("Storage")}
        </span>
      </div>

      {/* Total usage */}
      <div className="border-border mb-3 flex items-center gap-3 rounded-lg border px-4 py-3.5">
        <HardDrive size={16} strokeWidth={1.5} className="text-ink-muted shrink-0" />
        <span className="text-ink flex-1 text-sm">{localize("Total usage")}</span>
        <span className="text-ink text-sm font-medium tabular-nums">
          {localize(cacheLoading ? "..." : formatSize(totalSize))}
        </span>
      </div>

      <div className="border-border divide-border divide-y rounded-lg border">
        {/* Skins & custom mods */}
        <div className="flex items-center justify-between px-4 py-3.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-ink text-sm">{localize("Skins & Custom Mods")}</span>
            <span className="text-ink-muted text-xs">
              {localize("Downloaded skins and imported mods")}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <span className="text-ink-secondary min-w-16 text-right text-sm tabular-nums">
              {localize(cacheLoading ? "..." : formatSize(contentSize))}
            </span>
            <button
              onClick={handleClearContent}
              disabled={clearingContent || contentSize === 0 || patcherActive}
              className="border-border text-ink-secondary hover:text-error hover:border-error/40 flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors disabled:pointer-events-none disabled:opacity-30"
            >
              {localize(
                clearingContent ? (
                  <Loader2 size={13} strokeWidth={2} className="animate-spin" />
                ) : (
                  <Trash2 size={13} strokeWidth={1.5} />
                )
              )}
              {localize("Clear")}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 px-4 py-3.5">
          <div>
            <p className="text-ink text-sm">{localize("皮肤预览图片缓存")}</p>
            <p className="text-ink-muted mt-1 text-xs">
              {localize("已查看的原画保存在本地，切换页面和重启后优先复用；清理不影响已下载皮肤")}
            </p>
          </div>
          <span className="text-ink-secondary ml-auto text-sm">{formatSize(artSize)}</span>
          <button
            disabled={clearingArt || artSize === 0}
            onClick={async () => {
              setClearingArt(true);
              try {
                await clearArtwork();
                await refreshCache();
              } catch (e) {
                setPathError(String(e));
              } finally {
                setClearingArt(false);
              }
            }}
            className="border-border text-ink-secondary rounded border px-3 py-1.5 text-xs disabled:opacity-30"
          >
            {localize(clearingArt ? "正在清理…" : "Clear")}
          </button>
        </div>
        {/* Patcher data */}
        <div className="flex items-center justify-between px-4 py-3.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-ink text-sm">{localize("Patcher Data")}</span>
            <span className="text-ink-muted text-xs">
              {localize("已处理的皮肤与补丁缓存；清理后下次应用需要重新准备")}
            </span>
            <button
              onClick={() => void invoke("open_apply_log").catch(() => {})}
              className="text-gold-400 mt-1 cursor-pointer text-left text-xs"
            >
              {localize("打开应用耗时日志")}
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <span className="text-ink-secondary min-w-16 text-right text-sm tabular-nums">
              {localize(cacheLoading ? "..." : formatSize(workSize))}
            </span>
            <button
              onClick={handleClearWork}
              disabled={clearingWork || workSize === 0 || patcherActive}
              className="border-border text-ink-secondary hover:text-error hover:border-error/40 flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors disabled:pointer-events-none disabled:opacity-30"
            >
              {localize(
                clearingWork ? (
                  <Loader2 size={13} strokeWidth={2} className="animate-spin" />
                ) : (
                  <Trash2 size={13} strokeWidth={1.5} />
                )
              )}
              {localize("Clear")}
            </button>
          </div>
        </div>
      </div>

      {localize(
        patcherActive && (
          <p className="text-ink-muted mt-2 px-1 text-xs">
            {localize("Stop the patcher before clearing data.")}
          </p>
        )
      )}

      {localize(pathError && <Toast message={pathError} onClose={() => setPathError(null)} />)}
    </div>
  );
}
