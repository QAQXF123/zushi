import bundledQuality from "./skinQualityCatalog.json";
import { ensureSkinIds } from "../hooks/useSkinData";
import type { DownloadedSkin } from "../types";
export interface SkinQuality { id:number; rarity:string; isBase:boolean; }
const catalog=bundledQuality as Record<string,SkinQuality>;
const premium=new Set(["kLegendary","kUltimate","kExalted","kTranscendent"]);
const epic=new Set(["kEpic","kMythic"]);
const oldLegendary=/^(?:The )?Magnificent Twisted Fate$|^Red Baron Corki$|^Ice Toboggan Corki$|^Annie in Wonderland$|^Gentleman Cho['’]?Gath$/i;
const preferredThemes=/PROJECT:|Spirit Blossom|Dark (?:Star|Cosmic)|Cosmic|High Noon|Star Guardian|Battle Queen|Battle Academia|Battle Boss|Coven|Arcana|Blood Moon|Dawnbringer|Nightbringer|Dragonmancer|Empyrean|Winterblessed|Soul Fighter|Inkshadow|Faerie Court|Porcelain|Immortal Journey|Storm Dragon|Dream Dragon|Truth Dragon/i;
export const qualityLabels:Record<string,string>={kLegendary:"传说",kUltimate:"终极",kExalted:"超凡",kTranscendent:"殿堂",kEpic:"史诗",kMythic:"神话"};
export interface RandomSkinPlan { selection:Record<string,string>; paths:string[]; skipped:string[]; chosen:Array<{champion:string;skin:string;rarity:string;pool:number}>; }
export async function planRandomSkins(downloads:DownloadedSkin[],previous:Record<string,string>,excludedText:string,live?:Record<string,SkinQuality>):Promise<RandomSkinPlan>{
  const ids=await ensureSkinIds();
  const names=new Map(Object.entries(ids).map(([id,name])=>[name,id]));
  const quality={...catalog,...live};
  const exclude=excludedText.split(/[\n,，;；]/).map(x=>x.trim().toLowerCase()).filter(Boolean);
  const byChampion=new Map<string,DownloadedSkin[]>();
  for(const skin of downloads)byChampion.set(skin.champion_name,[...(byChampion.get(skin.champion_name)??[]),skin]);
  const plan:RandomSkinPlan={selection:{},paths:[],skipped:[],chosen:[]};
  for(const [champion,skins] of byChampion){
    const candidates=skins.filter(skin=>{
      const id=names.get(skin.skin_name);const meta=id?quality[id]:undefined;
      return meta&&!meta.isBase&&(premium.has(meta.rarity)||epic.has(meta.rarity))&&!oldLegendary.test(skin.skin_name)&&!exclude.some(term=>skin.skin_name.toLowerCase().includes(term));
    });
    const top=candidates.filter(skin=>premium.has(quality[names.get(skin.skin_name)!].rarity));
    const themed=candidates.filter(skin=>preferredThemes.test(skin.skin_name));
    const preferred=top.length?top:themed.length?themed:candidates;
    const alternatives=preferred.filter(skin=>skin.skin_name!==previous[champion]);
    const pool=alternatives.length?alternatives:preferred;
    if(!pool.length){plan.skipped.push(champion);continue;}
    const chosen=pool[crypto.getRandomValues(new Uint32Array(1))[0]%pool.length];
    plan.selection[champion]=chosen.skin_name;plan.paths.push(chosen.zip_path);
    plan.chosen.push({champion,skin:chosen.skin_name,rarity:quality[names.get(chosen.skin_name)!].rarity,pool:preferred.length});
  }
  return plan;
}
