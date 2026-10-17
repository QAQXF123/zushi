use super::skins::skins_dir;
use flate2::read::GzDecoder;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path};
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const URL: &str = "https://codeload.github.com/Alban1911/LeagueSkins/tar.gz/refs/heads/main";
static BUSY: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryProgress {
    phase: String,
    received_bytes: u64,
    total_bytes: Option<u64>,
    current: usize,
    total: usize,
    imported: usize,
    skipped: usize,
    error: Option<String>,
}
fn progress() -> &'static Mutex<LibraryProgress> {
    static VALUE: OnceLock<Mutex<LibraryProgress>> = OnceLock::new();
    VALUE.get_or_init(|| Mutex::new(LibraryProgress {phase: "idle".into(), ..Default::default()}))
}
fn update(f: impl FnOnce(&mut LibraryProgress)) { if let Ok(mut p) = progress().lock() { f(&mut p); } }
fn check_cancel() -> Result<(), String> {
    if CANCEL.load(Ordering::Relaxed) { Err("cancelled".into()) } else { Ok(()) }
}
struct JobGuard;
impl Drop for JobGuard { fn drop(&mut self) { BUSY.store(false, Ordering::Release); } }
#[tauri::command]
pub fn get_library_progress() -> LibraryProgress { progress().lock().unwrap().clone() }
#[tauri::command]
pub fn cancel_library_download() { CANCEL.store(true, Ordering::Relaxed); }
#[tauri::command]
pub async fn download_skin_library(app: AppHandle) -> Result<LibraryProgress, String> {
    if BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed).is_err() {
        return Err("全部皮肤下载任务已经在运行".into());
    }
    let guard = JobGuard;
    CANCEL.store(false, Ordering::Relaxed);
    update(|p| *p = LibraryProgress {phase:"downloading".into(), ..Default::default()});
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let result = (|| {
            let destination = skins_dir(&app)?;
            let cache = app.path().app_cache_dir().map_err(|e|e.to_string())?;
            fs::create_dir_all(&cache).map_err(|e|e.to_string())?;
            let archive = cache.join("all-skins.tar.gz");
            download_archive(&archive)?;
            update(|p|p.phase="indexing".into());
            import_archive(&archive, &destination, check_cancel, |current,total,imported,skipped| {
                update(|p| {p.phase="importing".into();p.current=current;p.total=total;p.imported=imported;p.skipped=skipped;});
            })?;
            Ok::<_,String>(())
        })();
        update(|p| match &result {
            Ok(()) => p.phase="done".into(),
            Err(e) if e == "cancelled" => p.phase="cancelled".into(),
            Err(e) => {p.phase="error".into();p.error=Some(e.clone());}
        });
        result.map(|_| get_library_progress())
    }).await.map_err(|e|e.to_string())?;
    result
}
fn download_archive(target: &Path) -> Result<(), String> {
    let temporary = target.with_extension("gz.part");
    let result = (|| {
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(15))
            .timeout_read(Duration::from_secs(60)).timeout_write(Duration::from_secs(60)).build();
        let response = agent.get(URL).call().map_err(|e|format!("下载全部皮肤失败：{e}"))?;
        let total = response.header("Content-Length").and_then(|s|s.parse::<u64>().ok());
        update(|p|p.total_bytes=total);
        let mut reader = response.into_reader();
        let mut file = File::create(&temporary).map_err(|e|e.to_string())?;
        let mut buffer = [0u8; 64*1024];
        let mut received = 0u64;
        let mut last_update = Instant::now();
        loop {
            check_cancel()?;
            let count = reader.read(&mut buffer).map_err(|e|format!("下载中断：{e}"))?;
            if count==0 {break;}
            received += count as u64;
            if received > 2*1024*1024*1024 {return Err("仓库压缩包超出大小限制".into());}
            file.write_all(&buffer[..count]).map_err(|e|e.to_string())?;
            if last_update.elapsed() >= Duration::from_millis(100) {
                update(|p|p.received_bytes=received);
                last_update=Instant::now();
            }
        }
        if received==0 || total.is_some_and(|n|n!=received) {return Err("下载的压缩包不完整，请重试".into());}
        file.sync_all().map_err(|e|e.to_string())?;
        drop(file);
        fs::rename(&temporary,target).map_err(|e|e.to_string())?;
        update(|p|p.received_bytes=received);
        Ok(())
    })();
    if result.is_err() {let _=fs::remove_file(temporary);}
    result
}
fn source(path: &Path) -> Result<tar::Archive<GzDecoder<File>>,String> {
    Ok(tar::Archive::new(GzDecoder::new(File::open(path).map_err(|e|e.to_string())?)))
}
fn component(name: &str) -> Result<String,String> {
    if name.is_empty() || name=="." || name==".." || name.contains('\0') {return Err("无效皮肤名称".into());}
    Ok(name.replace('/',"%2F"))
}
fn skin_id(path: &str) -> Option<&str> {
    if !path.contains("/skins/") || !(path.ends_with(".fantome") || path.ends_with(".zip")) {return None;}
    let filename=path.rsplit('/').next()?;
    let id=filename.rsplit_once('.')?.0;
    if id.bytes().all(|b|b.is_ascii_digit()) && !id.is_empty() {Some(id)} else {None}
}
pub fn import_archive(
    archive: &Path, destination: &Path,
    cancelled: impl Fn()->Result<(),String>,
    mut report: impl FnMut(usize,usize,usize,usize),
) -> Result<(usize,usize),String> {
    let mut ids: HashMap<String,String> = HashMap::new();
    let mut total=0usize;
    for entry in source(archive)?.entries().map_err(|e|e.to_string())? {
        cancelled()?;
        let mut entry=entry.map_err(|e|e.to_string())?;
        if !entry.header().entry_type().is_file() {continue;}
        let name=entry.path().map_err(|e|e.to_string())?.to_string_lossy().into_owned();
        if name.ends_with("/resources/en/skin_ids.json") {
            let mut bytes=Vec::new();
            (&mut entry).take(16*1024*1024).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
            ids=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
        }
        if skin_id(&name).is_some() {total+=1;}
    }
    if ids.is_empty() || total==0 {return Err("仓库中缺少皮肤文件或名称索引".into());}
    let mut files=Vec::new();
    let mut used=HashMap::new();
    let (mut imported,mut skipped)=(0usize,0usize);
    report(0,total,0,0);
    for entry in source(archive)?.entries().map_err(|e|e.to_string())? {
        cancelled()?;
        let mut entry=entry.map_err(|e|e.to_string())?;
        if !entry.header().entry_type().is_file() {continue;}
        let path=entry.path().map_err(|e|e.to_string())?.to_string_lossy().into_owned();
        let Some(id)=skin_id(&path) else {continue;};
        let id=id.to_string();
        if entry.size()>128*1024*1024 {return Err(format!("皮肤 {id} 超出大小限制"));}
        let mut data=Vec::new();
        entry.read_to_end(&mut data).map_err(|e|e.to_string())?;
        let mut zip=zip::ZipArchive::new(Cursor::new(&data)).map_err(|e|format!("皮肤 {id} 文件损坏：{e}"))?;
        let mut expanded=0u64;
        for i in 0..zip.len() {
            cancelled()?;
            let mut file=zip.by_index(i).map_err(|e|e.to_string())?;
            expanded=expanded.saturating_add(file.size());
            if expanded>512*1024*1024 {return Err(format!("皮肤 {id} 解压大小超出限制"));}
            std::io::copy(&mut file,&mut std::io::sink()).map_err(|e|format!("皮肤 {id} 校验失败：{e}"))?;
        }
        let number=id.parse::<u64>().map_err(|e|e.to_string())?;
        let champion=ids.get(&(number/1000*1000).to_string()).cloned().unwrap_or_else(||format!("Champion {}",number/1000));
        let mut name=match ids.get(&id) {
            Some(name)=>name.clone(),
            None=>{
                let info:Value=serde_json::from_reader(zip.by_name("META/info.json").map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
                info.get("Name").and_then(Value::as_str).filter(|s|!s.is_empty()).map(str::to_string).unwrap_or_else(||format!("Skin {id}"))
            }
        };
        if used.contains_key(&(champion.clone(),name.clone())) {name=format!("{name} [{id}]");}
        used.insert((champion.clone(),name.clone()),id.clone());
        ids.insert(id.clone(),name.clone());
        let folder=destination.join(component(&champion)?).join(component(&name)?);
        let target=folder.join(format!("{}.zip",component(&name)?));
        if fs::read(&target).ok().as_deref()==Some(data.as_slice()) {skipped+=1;}
        else {
            fs::create_dir_all(&folder).map_err(|e|e.to_string())?;
            let part=target.with_extension("zip.part");
            fs::write(&part,&data).map_err(|e|e.to_string())?;
            fs::rename(part,target).map_err(|e|e.to_string())?;
            imported+=1;
        }
        files.push(json!([id,format!("skins/{}",path.split_once("/skins/").unwrap().1)]));
        report(imported+skipped,total,imported,skipped);
    }
    cancelled()?;
    let metadata=json!({"format":"zushi-skins-v1","count":total,"skinIds":ids,"repoFiles":files});
    fs::create_dir_all(destination).map_err(|e|e.to_string())?;
    let part=destination.join(".zushi-library.json.part");
    fs::write(&part,serde_json::to_vec(&metadata).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    fs::rename(part,destination.join(".zushi-library.json")).map_err(|e|e.to_string())?;
    Ok((imported,skipped))
}
