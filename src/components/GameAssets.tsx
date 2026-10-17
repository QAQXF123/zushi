import { memo, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Json } from "../lib/matchHistory";
export interface GameAsset { id:number; name:string; iconPath:string; }
export interface GameAssets { items:GameAsset[]; spells:GameAsset[]; perks:GameAsset[]; }
const empty:GameAssets={items:[],spells:[],perks:[]};
let assets:GameAssets=empty;
let assetRequest:Promise<GameAssets>|undefined;
export function useGameAssets(connected:boolean) {
  const [value,setValue]=useState(assets);
  useEffect(()=>{
    if(!connected)return;
    let disposed=false;
    const request=assetRequest??=invoke<GameAssets>("get_client_game_assets");
    request.then(data=>{assets=data;if(!disposed)setValue(data);}).catch(()=>{}).finally(()=>{if(assetRequest===request)assetRequest=undefined;});
    return()=>{disposed=true;};
  },[connected]);
  return value;
}
// Shared queue prevents hundreds of simultaneous image requests on a detail page.
const images=new Map<string,string>();
const pending=new Map<string,Promise<string>>();
const queue:Array<()=>void>=[];
let active=0;
function pump(){while(active<4&&queue.length){active++;queue.shift()!();}}
function imageSource(path:string):Promise<string>{
  const cached=images.get(path);if(cached)return Promise.resolve(cached);
  const running=pending.get(path);if(running)return running;
  const request=new Promise<string>((resolve,reject)=>{
    queue.push(()=>{void invoke<string>("get_client_image",{path}).then(src=>{
      images.set(path,src);if(images.size>400)images.delete(images.keys().next().value!);resolve(src);
    }).catch(reject).finally(()=>{active--;pending.delete(path);pump();});});pump();
  });
  pending.set(path,request);return request;
}
export const GameImage=memo(function GameImage({path,title,size=24,fallback}:{path?:string;title:string;size?:number;fallback?:string}){
  const [src,setSrc]=useState<string|undefined>(()=>path?images.get(path):undefined);
  useEffect(()=>{let disposed=false;setSrc(path?images.get(path):undefined);if(path)void imageSource(path).then(value=>{if(!disposed)setSrc(value);}).catch(()=>{if(!disposed)setSrc(fallback);});return()=>{disposed=true;};},[path,fallback]);
  return <span title={title} className="bg-charcoal-300 inline-flex shrink-0 overflow-hidden rounded" style={{width:size,height:size}}>{src&&<img src={src} alt={title} className="h-full w-full object-cover" decoding="async" loading="lazy" onError={()=>setSrc(undefined)}/>}</span>;
});
export function Loadout({participant,assets,compact=false}:{participant?:Json;assets:GameAssets;compact?:boolean}){
  const stats=participant?.stats??{};
  const asset=(set:GameAsset[],id:unknown)=>set.find(x=>x.id===Number(id));
  const spells=[participant?.spell1Id,participant?.spell2Id].map(id=>asset(assets.spells,id));
  const perk=asset(assets.perks,stats.perk0);
  return <div className="flex shrink-0 items-center gap-2">
    <div className="flex flex-col gap-0.5">{spells.map((s,i)=><GameImage key={i} path={s?.iconPath} title={s?.name??"召唤师技能"} size={compact?16:20}/>)}</div>
    {!compact&&<GameImage path={perk?.iconPath} title={perk?.name??"主符文"} size={22}/>}
    <div className={`grid gap-0.5 ${compact?"grid-cols-4":"grid-cols-7"}`}>{Array.from({length:7},(_,i)=>{
      const id=Number(stats[`item${i}`]);const item=asset(assets.items,id);
      return <GameImage key={i} path={item?.iconPath} title={item?.name??(id?`装备 ${id}`:"空装备栏")} size={compact?17:23}/>;
    })}</div>
  </div>;
}
