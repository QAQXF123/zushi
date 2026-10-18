//! Local client integration. Credentials stay in Rust and requests stay on loopback.
//! Endpoint usage referenced from LeagueAkari's LCU HTTP helpers; no source copied.
use crate::state::AppState;
use super::history_store;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{State,Manager};

#[derive(Clone)]
struct Connection { port: u16, password: String }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientAccount {
    puuid: String, summoner_id: u64, game_name: String, tag_line: String,
    display_name: String, profile_icon_id: u64, level: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientSnapshot {
    connected: bool, account: Option<ClientAccount>, phase: String,
    champion_id: u64, platform: String, error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBatch { games: Vec<Value>, start: usize, count: usize, source: String, notice: Option<String> }

fn game_path(state: &State<'_, Arc<Mutex<AppState>>>) -> Option<String> {
    state.lock().ok().and_then(|s|s.game_path.clone())
}
fn discover(game: Option<&str>) -> Result<Connection,String> {
    let mut roots = Vec::new();
    if let Some(game)=game {
        let path=PathBuf::from(game);
        roots.push(path.clone());
        if let Some(parent)=path.parent() { roots.push(parent.to_path_buf()); }
    }
    roots.push(PathBuf::from("/Applications/League of Legends.app/Contents/LoL"));
    if let Ok(volumes)=fs::read_dir("/Volumes") {
        for volume in volumes.flatten() {
            for sub in ["League of Legends.app/Contents/LoL", "Applications/League of Legends.app/Contents/LoL"] {
                roots.push(volume.path().join(sub));
            }
        }
    }
    for root in roots {
        for path in [root.join("lockfile"), root.join("LeagueClient/lockfile")] {
            let Ok(text)=fs::read_to_string(path) else {continue;};
            let parts:Vec<_>=text.trim().split(':').collect();
            if parts.len()!=5 || parts[4]!="https" {continue;}
            let Ok(port)=parts[2].parse::<u16>() else {continue;};
            if port==0 || parts[3].is_empty() {continue;}
            return Ok(Connection {port,password:parts[3].into()});
        }
    }
    Err("未发现英雄联盟客户端，请先打开客户端并登录账号".into())
}
impl Connection {
    fn bytes(&self, endpoint: &str, body: Option<Value>) -> Result<Vec<u8>,String> {
        if !(endpoint.starts_with("/lol-") || endpoint.starts_with("/player-account/aliases/v1/lookup?") || endpoint=="/entitlements/v1/token") || endpoint.contains('\n') || endpoint.contains('\r') {return Err("无效的客户端接口".into());}
        // curl reads authentication from stdin, never from argv, logs or the webview.
        let escaped=self.password.replace('\\',"\\\\").replace('"',"\\\"");
        let mut config=format!("user = \"riot:{escaped}\"\n");
        if let Some(body)=body {
            let data=serde_json::to_string(&body).map_err(|e|e.to_string())?;
            let data=data.replace('\\',"\\\\").replace('"',"\\\"");
            config.push_str(&format!("request = \"POST\"\nheader = \"Content-Type: application/json\"\ndata = \"{data}\"\n"));
        }
        let mut child=Command::new("/usr/bin/curl")
            .args(["--silent","--show-error","--insecure","--noproxy","*","--connect-timeout","2","--max-time","15","--config","-","--url"])
            .arg(format!("https://127.0.0.1:{}{}",self.port,endpoint))
            .args(["--write-out","\n%{http_code}"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().map_err(|_|"无法连接客户端接口".to_string())?;
        let write=child.stdin.take().ok_or_else(||"无法读取客户端认证信息".to_string())?
            .write_all(config.as_bytes());
        let output=child.wait_with_output().map_err(|_|"读取客户端响应失败".to_string())?;
        if write.is_err() || !output.status.success() {return Err("客户端连接中断或请求超时，请确认已登录".into());}
        let split=output.stdout.iter().rposition(|b|*b==b'\n').ok_or_else(||"客户端返回了无效数据".to_string())?;
        let code=String::from_utf8_lossy(&output.stdout[split+1..]).trim().parse::<u16>().unwrap_or(0);
        match code {
            200..=299 => Ok(output.stdout[..split].to_vec()),
            401|403 => Err("客户端认证已失效或当前账号无权读取，请重新登录客户端".into()),
            404 => Err("客户端暂无该数据，或玩家不存在".into()),
            429 => Err("客户端请求过于频繁，请稍后再查".into()),
            _ => Err(format!("客户端暂时无法提供该数据（HTTP {code}）")),
        }
    }
    fn request(&self, endpoint: &str, body: Option<Value>) -> Result<Value,String> {
        serde_json::from_slice(&self.bytes(endpoint,body)?).map_err(|_|"客户端返回的数据无法解析".into())
    }

}
fn number(value: &Value, field: &str) -> u64 {
    value.get(field).and_then(|v|v.as_u64().or_else(||v.as_str()?.parse().ok())).unwrap_or(0)
}
fn text(value: &Value, field: &str) -> String {value.get(field).and_then(Value::as_str).unwrap_or("").into()}
fn account(value: &Value) -> Option<ClientAccount> {
    let puuid=text(value,"puuid");
    if puuid.is_empty() || puuid.bytes().all(|b|b==b'0'||b==b'-') {return None;}
    let game_name=text(value,"gameName");
    let display_name=text(value,"displayName");
    Some(ClientAccount {puuid,summoner_id:number(value,"summonerId"),game_name:if game_name.is_empty(){display_name.clone()}else{game_name},
        tag_line:text(value,"tagLine"),display_name,profile_icon_id:number(value,"profileIconId"),level:number(value,"summonerLevel")})
}
fn query_component(value: &str) -> String {
    value.bytes().map(|b| if b.is_ascii_alphanumeric() || matches!(b,b'-'|b'_'|b'.'|b'~') {(b as char).to_string()} else {format!("%{b:02X}")}).collect()
}
fn valid_puuid(puuid: &str) -> bool {
    !puuid.is_empty() && puuid.len()<=200 && puuid.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'-'|b'_'))
}
// Scoped to the live client connection; no credentials are written to disk.
fn client_platform(connection:&Connection)->String {
    use std::hash::{Hash,Hasher};
    let mut hash=std::collections::hash_map::DefaultHasher::new();
    connection.port.hash(&mut hash);connection.password.hash(&mut hash);let key=hash.finish();
    static PLATFORMS:OnceLock<Mutex<Option<(u64,String,Instant)>>>=OnceLock::new();
    let cache=PLATFORMS.get_or_init(||Mutex::new(None));
    if let Ok(guard)=cache.lock(){if let Some((id,platform,at))=guard.as_ref(){if *id==key&&at.elapsed()<Duration::from_secs(300){return platform.clone();}}}
    let platform=connection.request("/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=0",None).ok()
        .and_then(|v|v.pointer("/games/games/0/platformId").and_then(Value::as_str).map(str::to_uppercase))
        .or_else(||connection.request("/lol-platform-config/v1/namespaces/LoginDataPacket",None).ok().and_then(|v|v.get("platformId").and_then(Value::as_str).map(str::to_uppercase))).unwrap_or_default();
    if !platform.is_empty(){if let Ok(mut guard)=cache.lock(){*guard=Some((key,platform.clone(),Instant::now()));}}
    platform
}
fn check_platform(connection:&Connection,expected:&str)->Result<String,String>{
    let actual=client_platform(connection);
    if actual.is_empty(){return Err("无法识别当前客户端区服，请等待登录完成后重试".into());}
    if !expected.is_empty()&&actual!=expected{return Err(format!("当前连接的是 {actual}，请登录 {expected} 区服后更新；本地战绩仍可查看"));}
    Ok(actual)
}
#[tauri::command]
pub async fn get_client_snapshot(state: State<'_,Arc<Mutex<AppState>>>) -> Result<ClientSnapshot,String> {
    let path=game_path(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let result=(|| {
            let connection=discover(path.as_deref())?;
            let me=connection.request("/lol-summoner/v1/current-summoner",None)?;
            let me=account(&me).ok_or_else(||"客户端已打开，请先登录账号".to_string())?;
            let phase=connection.request("/lol-gameflow/v1/gameflow-phase",None).ok().and_then(|v|v.as_str().map(str::to_string)).unwrap_or_default();
            let mut champion=0;
            if phase=="ChampSelect" {
                if let Ok(session)=connection.request("/lol-champ-select/v1/session",None) {
                    let local=session.get("localPlayerCellId").and_then(Value::as_i64).unwrap_or(-1);
                    if let Some(team)=session.get("myTeam").and_then(Value::as_array) {
                        champion=team.iter().find(|p|p.get("cellId").and_then(Value::as_i64)==Some(local))
                            .map(|p|number(p,"championId")).unwrap_or(0);
                    }
                    if champion==0 {
                        if let Some(actions)=session.get("actions").and_then(Value::as_array) {
                            champion=actions.iter().filter_map(Value::as_array).flatten().filter(|a|
                                a.get("actorCellId").and_then(Value::as_i64)==Some(local) && text(a,"type")=="pick")
                                .map(|a|number(a,"championId")).find(|id|*id!=0).unwrap_or(0);
                        }
                    }
                }
            } else if matches!(phase.as_str(),"InProgress"|"GameStart"|"Reconnect") {
                if let Ok(session)=connection.request("/lol-gameflow/v1/session",None) {
                    if let Some(players)=session.pointer("/gameData/playerChampionSelections").and_then(Value::as_array) {
                        champion=players.iter().find(|p|number(p,"summonerId")==me.summoner_id).map(|p|number(p,"championId")).unwrap_or(0);
                    }
                }
            }
            Ok::<_,String>(ClientSnapshot {connected:true,account:Some(me),phase,champion_id:champion,platform:client_platform(&connection),error:None})
        })();
        result.unwrap_or_else(|e|ClientSnapshot{connected:false,account:None,phase:String::new(),champion_id:0,platform:String::new(),error:Some(e)})
    }).await.map_err(|e|e.to_string())
}
#[tauri::command]
pub async fn get_client_match_history(app:tauri::AppHandle,state: State<'_,Arc<Mutex<AppState>>>, puuid: String, start: usize, count: usize, use_sgp: Option<bool>, platform: Option<String>) -> Result<HistoryBatch,String> {
    if !valid_puuid(&puuid) {return Err("无效的玩家账号".into());}
    if start>=500 {return Ok(HistoryBatch{games:vec![],start,count:0,source:"LCU".into(),notice:None});}
    let count=count.clamp(1,20).min(500-start);
    let cache_root=history_store::root(&app)?;
    let path=game_path(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let connection=discover(path.as_deref())?;
        let platform=check_platform(&connection,platform.as_deref().unwrap_or(""))?;
        let started=Instant::now();
        let mut notice=None;
        if use_sgp==Some(true) {
            match sgp_history(&connection,&puuid,start,count) {
                Ok(mut games)=>{
                    for game in &mut games {game["_platform"]=json!(platform);if game["participants"].as_array().map_or(false,|p|p.len()>1){
                        history_store::write(&cache_root,"detail",&format!("{}:{}",platform,number(game,"gameId")),game)?;
                    }}
                    history_store::trace(&cache_root,"history-request",json!({"source":"SGP","start":start,"count":games.len(),"ms":started.elapsed().as_millis()}));
                    return Ok(HistoryBatch{count:games.len(),games,start,source:"SGP".into(),notice:None});
                },
                Err(error)=>{if start>0{return Err(format!("云端分页中断，可稍后继续：{error}"));}notice=Some(format!("云端战绩暂不可用，已回退客户端：{error}"));},
            }
        }
        let data=connection.request(&format!("/lol-match-history/v1/products/lol/{puuid}/matches?begIndex={start}&endIndex={}",start+count-1),None)?;
        let mut games=data.pointer("/games/games").and_then(Value::as_array).cloned().unwrap_or_default();
        if start>0&&!games.is_empty()&&data.pointer("/games/gameIndexBegin").and_then(Value::as_u64)==Some(0) {
            return Err(format!("客户端忽略了分页参数，仍返回最近 20 场。{}",notice.unwrap_or_else(||"请启用云端战绩，使用 SGP 分页查询更多记录。".into())));
        }
        games.truncate(count);
        for game in &mut games {game["_platform"]=json!(platform);game["_source"]=json!("LCU");}
        history_store::trace(&cache_root,"history-request",json!({"source":"LCU","start":start,"count":games.len(),"ms":started.elapsed().as_millis()}));
        Ok(HistoryBatch{count:games.len(),games,start,source:"LCU".into(),notice})
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn search_client_player(state: State<'_,Arc<Mutex<AppState>>>, riot_id: String) -> Result<ClientAccount,String> {
    let query=riot_id.trim().to_string();
    if query.is_empty() || query.len()>200 {return Err("请输入玩家的名字#标签".into());}
    let path=game_path(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let connection=discover(path.as_deref())?;
        let mut attempts=Vec::new();
        if let Some((name,tag))=query.rsplit_once('#') {
            if name.trim().is_empty()||tag.trim().is_empty() {return Err("请输入完整的名字#标签".into());}
            attempts.push((format!("/lol-summoner/v1/summoners-by-name/{}",query_component(&query)),None));
            attempts.push(("/lol-summoner/v1/summoners/aliases".into(),Some(json!([{"gameName":name.trim(),"tagLine":tag.trim()}]))));
        }
        attempts.push((format!("/lol-summoner/v1/summoners?name={}",query_component(&query)),None));
        attempts.push((format!("/player-account/aliases/v1/lookup?query={}",query_component(&query)),None));
        fn resolve(value:&Value)->Option<ClientAccount> {
            account(value).or_else(||value.as_array().and_then(|items|items.iter().find_map(resolve)))
                .or_else(||["aliases","data","summoner","account"].iter().find_map(|key|value.get(key).and_then(resolve)))
        }
        let mut last_error=String::new();
        for (endpoint,body) in attempts {
            match connection.request(&endpoint,body) {
                Ok(value)=>if let Some(found)=resolve(&value) {
                    let enriched=connection.request(&format!("/lol-summoner/v2/summoners/puuid/{}",found.puuid),None).ok().and_then(|v|account(&v));
                    return Ok(enriched.unwrap_or(found));
                },
                Err(error)=>last_error=error,
            }
        }
        Err(format!("未找到这个玩家，请检查名字#标签和当前服务器。{last_error}"))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn get_client_match_detail(app:tauri::AppHandle,state: State<'_,Arc<Mutex<AppState>>>, game_id: String, use_sgp: Option<bool>, platform:String, offline:Option<bool>) -> Result<Value,String> {
    if game_id.is_empty()||game_id.len()>24||!game_id.bytes().all(|b|b.is_ascii_digit()) {return Err("无效的对局编号".into());}
    let path=game_path(&state);
    let root=history_store::root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let key=format!("{platform}:{game_id}");
        if let Some(cached)=history_store::read(&root,"detail",&key)?{return Ok(cached);}
        if offline==Some(true){return Err("此对局详情尚未缓存，请连接对应区服客户端后打开".into());}
        let connection=discover(path.as_deref())?;
        check_platform(&connection,&platform)?;
        let mut game=if use_sgp==Some(true){
            let route=sgp_route(&connection)?;
            let data=sgp_request(&connection,&route,&format!("/match-history-query/v1/products/lol/{}_{game_id}/SUMMARY",route.platform))?;
            normalize_sgp(&data)?
        } else {connection.request(&format!("/lol-match-history/v1/games/{game_id}"),None)?};
        game["_platform"]=json!(platform);
        history_store::write(&root,"detail",&key,&game)?;
        Ok(game)
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn get_client_queues(state: State<'_,Arc<Mutex<AppState>>>) -> Result<Value,String> {
    let path=game_path(&state);
    tauri::async_runtime::spawn_blocking(move ||discover(path.as_deref())?.request("/lol-game-queues/v1/queues",None)).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn get_client_player_profile(state: State<'_,Arc<Mutex<AppState>>>, puuid:String,platform:Option<String>)->Result<Value,String> {
    if !valid_puuid(&puuid) {return Err("无效的玩家账号".into());}
    let path=game_path(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let connection=discover(path.as_deref())?;
        check_platform(&connection,platform.as_deref().unwrap_or(""))?;
        let (profile,ranked)=std::thread::scope(|scope| {
            let profile=scope.spawn(||connection.request(&format!("/lol-summoner/v2/summoners/puuid/{puuid}"),None));
            let ranked=connection.request(&format!("/lol-ranked/v1/ranked-stats/{puuid}"),None);
            (profile.join().unwrap_or_else(|_|Err("账号资料暂时不可用".into())),ranked)
        });
        let profile=profile.ok().and_then(|v|account(&v));
        let error=ranked.as_ref().err().cloned();
        Ok(json!({"account":profile,"ranked":ranked.ok(),"rankError":error}))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn get_client_game_assets(state: State<'_,Arc<Mutex<AppState>>>)->Result<Value,String> {
    let path=game_path(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let connection=discover(path.as_deref())?;
        let sets=std::thread::scope(|scope| {
            let tasks:Vec<_>=[("items","items"),("spells","summoner-spells"),("perks","perks")].into_iter().map(|(key,file)| {
                let connection=&connection;
                scope.spawn(move ||(key,connection.request(&format!("/lol-game-data/assets/v1/{file}.json"),None).ok()))
            }).collect();
            tasks.into_iter().filter_map(|t|t.join().ok()).collect::<Vec<_>>()
        });
        let mut result=serde_json::Map::new();
        for (key,data) in sets {
            let compact:Vec<_>=data.and_then(|v|v.as_array().cloned()).unwrap_or_default().iter().map(|v|json!({"id":v["id"],"name":v["name"],"iconPath":v["iconPath"]})).collect();
            result.insert(key.into(),json!(compact));
        }
        Ok(Value::Object(result))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn get_client_image(app:tauri::AppHandle,state: State<'_,Arc<Mutex<AppState>>>, path:String)->Result<String,String> {
    use base64::Engine;
    if !path.starts_with("/lol-game-data/assets/")||path.contains("..")||path.contains('?')||path.contains('#')||!path.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'/'|b'-'|b'_'|b'.')) {
        return Err("无效的客户端图片路径".into());
    }
    let mime=if path.ends_with(".png"){"image/png"}else if path.ends_with(".jpg")||path.ends_with(".jpeg"){"image/jpeg"}else{return Err("不支持的图片格式".into());};
    let game=game_path(&state);
    let root=history_store::root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cached=history_store::read(&root,"image",&path)?;
        let cached_src=cached.as_ref().and_then(|v|v.get("src").and_then(Value::as_str).or_else(||v.as_str()));
        let fresh=cached.as_ref().and_then(|v|v.get("fetchedAt")).and_then(Value::as_u64).map_or(false,|at|history_store::now().saturating_sub(at)<86_400_000);
        if fresh {if let Some(src)=cached_src{return Ok(src.to_owned());}}
        let data=match discover(game.as_deref()).and_then(|c|c.bytes(&path,None)){
            Ok(data)=>data,Err(e)=>{if let Some(src)=cached_src{return Ok(src.to_owned());}return Err(e);}
        };
        if data.len()>2_000_000 {return Err("图片过大".into());}
        let src=format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(data));
        history_store::write(&root,"image",&path,&json!({"src":src,"fetchedAt":history_store::now()}))?;
        Ok(src)
    }).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn get_client_skin_quality(state:State<'_,Arc<Mutex<AppState>>>)->Result<Value,String>{
    let path=game_path(&state);
    tauri::async_runtime::spawn_blocking(move||{
        let skins=discover(path.as_deref())?.request("/lol-game-data/assets/v1/skins.json",None)?;
        let mut result=serde_json::Map::new();
        if let Some(skins)=skins.as_object(){for(id,skin)in skins {result.insert(id.clone(),json!({"id":skin["id"],"rarity":skin["rarity"],"isBase":skin["isBase"]}));}}
        Ok(Value::Object(result))
    }).await.map_err(|e|e.to_string())?
}

#[derive(Serialize)]
pub struct SgpRoute { platform:String, host:String }
fn sgp_route(connection:&Connection)->Result<SgpRoute,String>{
    let platform=client_platform(connection);
    // Fixed destinations from League Akari's server configuration. Never accept a URL from the webview.
    let host=match platform.as_str(){
        "TW2"|"SG2"|"PH2"|"VN2"|"TH2"|"OC1"=>"https://apse1-red.pp.sgp.pvp.net",
        "KR"|"JP1"=>"https://apne1-red.pp.sgp.pvp.net",
        "NA1"|"BR1"|"LA1"|"LA2"|"PBE1"=>"https://usw2-red.pp.sgp.pvp.net",
        "EUW1"|"EUN1"|"RU"|"TR1"=>"https://euc1-red.pp.sgp.pvp.net",
        _=>return Err("当前区服未配置云端战绩接口，或客户端暂无区服信息".into()),
    };
    Ok(SgpRoute{platform,host:host.into()})
}
fn sgp_request(connection:&Connection,route:&SgpRoute,endpoint:&str)->Result<Value,String>{
    let credentials=connection.request("/entitlements/v1/token",None)?;
    let token=credentials.get("accessToken").and_then(Value::as_str).filter(|s|!s.is_empty()).ok_or_else(||"客户端未提供战绩授权，请重新登录".to_string())?;
    // This branch is used only after explicit cloud-query consent. TLS validation stays enabled,
    // redirects are disabled, and tokens never reach the webview, disk or process arguments.
    let agent=ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(8)).timeout(std::time::Duration::from_secs(25)).redirects(0).build();
    let response=agent.get(&format!("{}{endpoint}",route.host)).set("Authorization",&format!("Bearer {token}")).call().map_err(|error|match error{
        ureq::Error::Status(code,_)=>format!("战绩服务器返回 HTTP {code}"),
        _=>"无法连接战绩服务器，请检查网络".into(),
    })?;
    serde_json::from_reader(response.into_reader().take(20_000_000)).map_err(|_|"战绩服务器返回的数据无法解析".into())
}
fn normalize_sgp(data:&Value)->Result<Value,String>{
    let raw=data.get("json").unwrap_or(data);
    if number(raw,"gameId")==0{return Err("云端返回了无效的对局记录".into());}
    let mut game=raw.clone();
    let mut participants=Vec::new();let mut identities=Vec::new();
    for (index,player)in raw.get("participants").and_then(Value::as_array).into_iter().flatten().enumerate(){
        let id=player.get("participantId").cloned().unwrap_or(json!(index+1));
        let mut stats=player.clone();
        if let Some(subteam)=player.get("playerSubteamId"){stats["subteamId"]=subteam.clone();}
        if let Some(styles)=player.pointer("/perks/styles").and_then(Value::as_array){
            let perks:Vec<_>=styles.iter().filter_map(|s|s.get("selections").and_then(Value::as_array)).flatten().filter_map(|s|s.get("perk")).collect();
            for (i,perk) in perks.iter().take(6).enumerate(){stats[format!("perk{i}")]=(*perk).clone();}
        }
        participants.push(json!({"participantId":id,"championId":player["championId"],"teamId":player["teamId"],"spell1Id":player.get("summoner1Id").or_else(||player.get("spell1Id")),"spell2Id":player.get("summoner2Id").or_else(||player.get("spell2Id")),"stats":stats}));
        identities.push(json!({"participantId":id,"player":{"puuid":player["puuid"],"summonerId":player["summonerId"],"summonerName":player["summonerName"],"gameName":player["riotIdGameName"],"tagLine":player["riotIdTagline"],"profileIcon":player["profileIcon"]}}));
    }
    game["participants"]=json!(participants);game["participantIdentities"]=json!(identities);game["_source"]=json!("SGP");
    Ok(game)
}
fn sgp_history(connection:&Connection,puuid:&str,start:usize,count:usize)->Result<Vec<Value>,String>{
    let route=sgp_route(connection)?;
    let data=sgp_request(connection,&route,&format!("/match-history-query/v1/products/lol/player/{puuid}/SUMMARY?startIndex={start}&count={count}"))?;
    let rows=data.get("games").and_then(Value::as_array).ok_or_else(||"云端战绩缺少对局列表".to_string())?;
    rows.iter().take(count).map(normalize_sgp).collect()
}
#[tauri::command]
pub async fn get_client_sgp_route(app:tauri::AppHandle,state:State<'_,Arc<Mutex<AppState>>>)->Result<Value,String>{
    let path=game_path(&state);
    let consent=app.path().app_data_dir().ok().and_then(|p|p.parent().map(|parent|parent.join("Zushi/cloud-consent.json")));
    tauri::async_runtime::spawn_blocking(move||{
        let route=sgp_route(&discover(path.as_deref())?)?;
        let approved=consent.and_then(|p|fs::read_to_string(p).ok()).and_then(|s|serde_json::from_str::<Value>(&s).ok())
            .and_then(|v|v.get("hosts").and_then(Value::as_array).cloned()).map(|hosts|hosts.iter().any(|host|host.as_str()==Some(&route.host))).unwrap_or(false);
        Ok(json!({"platform":route.platform,"host":route.host,"approved":approved}))
    }).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn get_client_champ_select(state:State<'_,Arc<Mutex<AppState>>>)->Result<Value,String>{
    let path=game_path(&state);
    tauri::async_runtime::spawn_blocking(move||{
        let connection=discover(path.as_deref())?;
        let session=connection.request("/lol-champ-select/v1/session",None)?;
        let players:Vec<_>=session.get("myTeam").and_then(Value::as_array).into_iter().flatten().map(|p|json!({
            "puuid":p["puuid"],"summonerId":p["summonerId"],"championId":p["championId"],"position":p["assignedPosition"],"cellId":p["cellId"]
        })).collect();
        Ok(json!({"players":players,"localCellId":session["localPlayerCellId"]}))
    }).await.map_err(|e|e.to_string())?
}
