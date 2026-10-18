//! Public Riot artwork cache. No client credentials or arbitrary URLs.
use base64::Engine;
use serde_json::{json,Value};
use std::io::Read;
use std::path::PathBuf;
use std::sync::{OnceLock,atomic::{AtomicU64,Ordering}};
use tauri::Manager;
static EPOCH:AtomicU64=AtomicU64::new(0);
static TEMP:AtomicU64=AtomicU64::new(0);
fn root(app:&tauri::AppHandle)->Result<PathBuf,String>{app.path().app_cache_dir().map(|p|p.join("artwork-v1")).map_err(|e|e.to_string())}
fn image_data(bytes:&[u8])->Result<String,String>{
    let mime=if bytes.starts_with(b"\x89PNG\r\n\x1a\n"){"image/png"}else if bytes.starts_with(&[255,216,255]){"image/jpeg"}else{return Err("Invalid artwork response".into());};
    Ok(format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes)))
}
#[tauri::command]
pub async fn get_cached_art(app:tauri::AppHandle,url:String)->Result<String,String>{
    let path=url.strip_prefix("https://ddragon.leagueoflegends.com/cdn/").ok_or("Invalid artwork host")?;
    if path.len()>300||path.split('/').any(|s|s.is_empty()||s=="."||s=="..")||!path.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'/'|b'_'|b'-'|b'.'))||!(path.ends_with(".png")||path.ends_with(".jpg"))||!path.contains("/champion/") {return Err("Invalid artwork path".into());}
    let log=super::history_store::root(&app)?;
    let root=root(&app)?;let file=root.join(path.replace('/',"_"));let epoch=EPOCH.load(Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move||{
        let started=std::time::Instant::now();
        if let Ok(bytes)=std::fs::read(&file){if let Ok(data)=image_data(&bytes){super::history_store::trace(&log,"artwork",json!({"cache":"disk","bytes":bytes.len(),"ms":started.elapsed().as_millis()}));return Ok(data);}}
        static AGENT:OnceLock<ureq::Agent>=OnceLock::new();
        let agent=AGENT.get_or_init(||ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(6)).timeout(std::time::Duration::from_secs(20)).redirects(0).build());
        let response=agent.get(&url).call().map_err(|_|"Could not load artwork; check your connection".to_string())?;
        let mut bytes=Vec::new();response.into_reader().take(5_000_001).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
        if bytes.len()>5_000_000{return Err("Artwork exceeds size limit".into());}
        let data=image_data(&bytes)?;
        if EPOCH.load(Ordering::SeqCst)==epoch {
            std::fs::create_dir_all(&root).map_err(|e|e.to_string())?;
            let temp=root.join(format!(".{}-{}-{}.tmp",std::process::id(),TEMP.fetch_add(1,Ordering::Relaxed),file.file_name().unwrap_or_default().to_string_lossy()));
            if let Err(error)=std::fs::write(&temp,&bytes).and_then(|_|std::fs::rename(&temp,&file)){let _=std::fs::remove_file(temp);return Err(error.to_string());}
        }
        super::history_store::trace(&log,"artwork",json!({"cache":"network","bytes":bytes.len(),"ms":started.elapsed().as_millis()}));
        Ok(data)
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn get_art_cache_info(app:tauri::AppHandle)->Result<Value,String>{let root=root(&app)?;
    tauri::async_runtime::spawn_blocking(move||Ok(json!({"bytes":super::dir_size(&root),"count":std::fs::read_dir(root).map(|r|r.filter_map(Result::ok).filter(|e|!e.file_name().to_string_lossy().starts_with('.')).count()).unwrap_or(0)}))).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn clear_art_cache(app:tauri::AppHandle)->Result<(),String>{let root=root(&app)?;EPOCH.fetch_add(1,Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move||{if root.exists(){std::fs::remove_dir_all(root).map_err(|e|e.to_string())?;}Ok(())}).await.map_err(|e|e.to_string())?
}
