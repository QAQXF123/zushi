import { ensureSkinIds, getSkinsGroupedForChampion, getSplashNum } from "../hooks/useSkinData";
import { splashUrl, findChampionByName } from "../hooks/useChampions";
import { prefetchArtwork } from "./artwork";
let hovered: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
export function prefetchChampionArtwork(name: string) {
  if (hovered === name) return;
  hovered = name;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const champion = findChampionByName(name);
    if (!champion) return;
    void ensureSkinIds()
      .then((ids) => {
        if (hovered !== name) return;
        prefetchArtwork(
          getSkinsGroupedForChampion(champion, ids)
            .slice(0, 8)
            .map((g) => splashUrl(champion.id, getSplashNum(g.base)))
        );
      })
      .catch(() => {});
  }, 160);
}
