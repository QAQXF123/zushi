import { localize } from "../i18n";
import { invoke } from "@tauri-apps/api/core";

interface UpdateBannerProps {
  version: string;
  releasesUrl: string;
}

export default function UpdateBanner({ version, releasesUrl }: UpdateBannerProps) {
  return (
    <div className="border-gold-400/20 bg-gold-400/8 mx-3 mt-auto mb-3 flex flex-col gap-2 rounded-lg border p-3">
      <span className="text-ink text-xs font-medium">
        {localize("v")}
        {localize(version)}
        {localize(" available")}
      </span>
      <button
        onClick={() => invoke("open_url", { url: releasesUrl }).catch(() => {})}
        className="bg-gold-400 text-charcoal-600 hover:bg-gold-300 w-full cursor-pointer rounded px-3 py-1.5 text-xs font-medium transition-colors"
      >
        {localize("Download update")}
      </button>
    </div>
  );
}
