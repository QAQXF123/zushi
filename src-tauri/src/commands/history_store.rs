//! Durable non-secret battle-history data. Credentials are never stored here.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

pub fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
// Authorization Services leaves a real GUI uid and an effective root uid.
// Keep user data owned by the GUI user so SQLite's permission checks agree
// with the process's file access. Only fixed cache files are touched, through
// no-follow descriptors, before SQLite opens them (closing an unrelated DB fd
// while SQLite is active would invalidate POSIX locks).
fn prepare_cache(root:&Path)->Result<(),String>{
    use std::os::unix::fs::{MetadataExt,OpenOptionsExt};
    use std::os::fd::AsRawFd;
    std::fs::create_dir_all(root).map_err(|e|e.to_string())?;
    if unsafe{libc::geteuid()}!=0{return Ok(());}
    let home=std::env::var("HOME").map_err(|e|e.to_string())?;
    let owner=std::fs::metadata(home).map_err(|e|e.to_string())?;
    let uid=owner.uid();let gid=owner.gid();
    if uid==0{return Ok(());}
    let adopt=|file:&std::fs::File|->Result<(),String>{
        let meta=file.metadata().map_err(|e|e.to_string())?;
        if (meta.uid()!=uid||meta.gid()!=gid)&&unsafe{libc::fchown(file.as_raw_fd(),uid,gid)}!=0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    };
    let directory=std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW|libc::O_DIRECTORY).open(root).map_err(|e|e.to_string())?;
    adopt(&directory)?;
    for name in ["match-history.sqlite3","match-history.sqlite3-wal","match-history.sqlite3-shm","match-history.sqlite3-journal"] {
        let result=std::fs::OpenOptions::new().read(true).write(true).create(name=="match-history.sqlite3").custom_flags(libc::O_NOFOLLOW|libc::O_NONBLOCK).open(root.join(name));
        match result {
            Ok(file)=>{if !file.metadata().map_err(|e|e.to_string())?.is_file(){return Err("Cache path is not a regular file".into());}adopt(&file)?;},
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{},
            Err(e)=>return Err(e.to_string()),
        }
    }
    trace(root,"cache-owner",json!({"uid":uid,"gid":gid}));
    Ok(())
}
// SQLite is synchronous. Keep all DB work on spawn_blocking threads, reuse a
// connection, and serialize operations before entering SQLite (not via busy locks).
// Network requests and image downloads must never run inside this closure.
fn with_db<T>(root: &Path, label: &str, operation: impl FnOnce(&mut Connection) -> Result<T,String>) -> Result<T,String> {
    static DATABASES: OnceLock<Mutex<HashMap<PathBuf,Connection>>> = OnceLock::new();
    let started=std::time::Instant::now();
    let mut databases=DATABASES.get_or_init(||Mutex::new(HashMap::new())).lock()
        .map_err(|_|"Local cache access queue unavailable".to_string())?;
    let queued_ms=started.elapsed().as_millis();
    if !databases.contains_key(root) {
        prepare_cache(root)?;
        let mut db=Connection::open(root.join("match-history.sqlite3")).map_err(|e|sql_error(root,"open",e))?;
        trace(root,"database-open",json!({"sqliteVersion":rusqlite::version(),"readonly":db.is_readonly(rusqlite::DatabaseName::Main).ok(),"uid":unsafe{libc::getuid()},"euid":unsafe{libc::geteuid()}}));
        db.busy_timeout(std::time::Duration::from_secs(10)).map_err(|e|e.to_string())?;
        // Our single serialized connection does not need WAL shared-memory
        // locks. Let SQLite checkpoint/convert existing WAL itself; never remove
        // the sidecars or recreate the database to work around a lock.
        let journal:String=db.pragma_query_value(None,"journal_mode",|row|row.get(0)).map_err(|e|sql_error(root,"read-journal-mode",e))?;
        if !journal.eq_ignore_ascii_case("delete") {
            trace(root,"journal-conversion-start",json!({"from":journal,"to":"delete"}));
            db.pragma_update(None,"journal_mode","DELETE").map_err(|e|sql_error(root,"convert-journal",e))?;
        }
        let journal:String=db.pragma_query_value(None,"journal_mode",|row|row.get(0)).map_err(|e|sql_error(root,"verify-journal-mode",e))?;
        if !journal.eq_ignore_ascii_case("delete"){return Err(format!("Cache journal conversion incomplete: {journal}"));}
        let version:u32=db.pragma_query_value(None,"user_version",|row|row.get(0)).map_err(|e|sql_error(root,"schema-version",e))?;
        if version>1{return Err("Cache was created by a newer app; original database retained".into());}
        if version==0 {
            let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|sql_error(root,"begin-immediate",e))?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS records (
                kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, updated INTEGER NOT NULL,
                PRIMARY KEY(kind,id)); PRAGMA user_version=1;").map_err(|e|e.to_string())?;
            tx.commit().map_err(|e|sql_error(root,"commit",e))?;
        }
        databases.insert(root.to_path_buf(),db);
        trace(root,"database-ready",json!({"journal":journal,"version":1,"sharedConnection":true,"sqliteVersion":rusqlite::version(),"pid":std::process::id()}));
    }
    let db=databases.get_mut(root).ok_or_else(||"Local cache unavailable".to_string())?;
    trace(root,"db-operation-start",json!({"operation":label,"queuedMs":queued_ms,"autocommit":db.is_autocommit(),"busyStatements":db.is_busy()}));
    let result=operation(db);
    trace(root,if result.is_ok(){"db-operation-ok"}else{"db-operation-error"},json!({"operation":label,"elapsedMs":started.elapsed().as_millis(),"error":result.as_ref().err(),"autocommit":db.is_autocommit(),"busyStatements":db.is_busy()}));
    result
}
pub fn root(app: &tauri::AppHandle) -> Result<PathBuf,String> { app.path().app_data_dir().map(|p|p.join("battle-history")).map_err(|e|e.to_string()) }
pub fn read(root:&std::path::Path,kind:&str,id:&str)->Result<Option<Value>,String> {
    let value:Option<String>=with_db(root,"read",|db|db.query_row(
        "SELECT payload FROM records WHERE kind=?1 AND id=?2",params![kind,id],|r|r.get(0))
        .optional().map_err(|e|e.to_string()))?;
    trace(root,"cache-read",json!({"kind":kind,"hit":value.is_some()}));
    value.map(|s|serde_json::from_str(&s).map_err(|e|format!("战绩缓存读取失败，原数据已保留：{e}"))).transpose()
}
pub fn write(root:&std::path::Path,kind:&str,id:&str,value:&Value)->Result<(),String> {
    let bytes=with_db(root,"write",|db|{
    let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|sql_error(root,"begin-immediate",e))?;
    let mut value=value.clone();
    if kind=="history" {
        let old:Option<String>=tx.query_row("SELECT payload FROM records WHERE kind=?1 AND id=?2",params![kind,id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(old)=old {
            let old:Value=serde_json::from_str(&old).map_err(|e|format!("Invalid stored history; original retained: {e}"))?;
            let mut games=std::collections::BTreeMap::<String,Value>::new();
            for game in old.get("games").and_then(Value::as_array).into_iter().flatten().chain(value.get("games").and_then(Value::as_array).into_iter().flatten()) {
                let id=game.get("gameId").map(Value::to_string).unwrap_or_default();
                if id.is_empty(){continue;}
                let count=|g:&Value|g.get("participants").and_then(Value::as_array).map_or(0,Vec::len);
                if games.get(&id).map_or(true,|prior|count(game)>=count(prior)){games.insert(id,game.clone());}
            }
            let mut games:Vec<_>=games.into_values().collect();
            games.sort_by_key(|g|std::cmp::Reverse(g.get("gameCreation").and_then(Value::as_u64).unwrap_or(0)));
            if old.get("fetchedAt").and_then(Value::as_u64)>value.get("fetchedAt").and_then(Value::as_u64){value=old;}
            value["games"]=json!(games);
        }
    }
    let payload=serde_json::to_string(&value).map_err(|e|e.to_string())?;
    if payload.len()>40_000_000{return Err("Single cache record exceeds 40 MB".into());}
    tx.execute("INSERT INTO records(kind,id,payload,updated) VALUES(?1,?2,?3,?4)
        ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated",params![kind,id,payload,now()]).map_err(|e|sql_error(root,"upsert",e))?;
    tx.commit().map_err(|e|sql_error(root,"commit",e))?;
    Ok(payload.len())
    })?;
    trace(root,"cache-write",json!({"kind":kind,"bytes":bytes}));
    Ok(())
}
fn sql_error(root:&Path,stage:&str,error:rusqlite::Error)->String {
    let detail=match &error {
        rusqlite::Error::SqliteFailure(code,_)=>format!("{error} [stage={stage}, code={:?}, extended={}]",code.code,code.extended_code),
        _=>format!("{error} [stage={stage}]"),
    };
    trace(root,"sqlite-error",json!({"stage":stage,"detail":detail}));
    if matches!(&error,rusqlite::Error::SqliteFailure(code,_) if matches!(code.code,rusqlite::ErrorCode::DatabaseBusy|rusqlite::ErrorCode::DatabaseLocked)) {
        static LAST:Mutex<u64>=Mutex::new(0);
        if let Ok(mut last)=LAST.lock(){if now().saturating_sub(*last)>30_000 {
            *last=now();
            if let Ok(output)=std::process::Command::new("/usr/sbin/lsof").arg("-n").arg(root.join("match-history.sqlite3")).output(){
                trace(root,"database-lock-owners",json!({"output":String::from_utf8_lossy(&output.stdout),"error":String::from_utf8_lossy(&output.stderr)}));
            }
        }}
    }
    detail
}
// Bounded diagnostic log: timings/cache status only, never credentials or response bodies.
pub fn trace(root:&std::path::Path,event:&str,fields:Value){
    use std::io::Write;
    static LOG:std::sync::Mutex<()>=std::sync::Mutex::new(());
    let Ok(_lock)=LOG.lock() else{return;};
    let file=root.join("history-diagnostics.jsonl");
    if std::fs::metadata(&file).map_or(false,|m|m.len()>2_000_000){let _=std::fs::rename(&file,root.join("history-diagnostics.previous.jsonl"));}
    if let Ok(mut file)=std::fs::OpenOptions::new().create(true).append(true).open(file){let _=writeln!(file,"{}",json!({"time":now(),"pid":std::process::id(),"event":event,"data":fields}));}
}
fn valid(kind:&str,id:&str)->bool {
    ["history","profile","players","view","self","assets","queues","detail","image"].contains(&kind)&&!id.is_empty()&&id.len()<1000
}
#[tauri::command]
pub async fn read_history_cache(app:tauri::AppHandle,kind:String,id:String)->Result<Option<Value>,String>{
    if !valid(&kind,&id){return Err("无效的缓存类型".into());}
    let root=root(&app)?;
    tauri::async_runtime::spawn_blocking(move||read(&root,&kind,&id)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn write_history_cache(app:tauri::AppHandle,kind:String,id:String,value:Value)->Result<(),String>{
    // Details/images are written by the validated Rust client commands only.
    if !valid(&kind,&id)||["detail","image"].contains(&kind.as_str()){return Err("无效的缓存类型".into());}
    let root=root(&app)?;
    tauri::async_runtime::spawn_blocking(move||write(&root,&kind,&id,&value)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn get_history_cache_info(app:tauri::AppHandle)->Result<Value,String>{
    let root=root(&app)?;
    tauri::async_runtime::spawn_blocking(move||{
        let rows=with_db(&root,"stats",|db|{
        let mut stmt=db.prepare("SELECT kind,COUNT(*),MAX(updated) FROM records GROUP BY kind").map_err(|e|e.to_string())?;
        let rows=stmt.query_map([],|r|Ok(json!({"kind":r.get::<_,String>(0)?,"count":r.get::<_,u64>(1)?,"updated":r.get::<_,u64>(2)?}))).map_err(|e|e.to_string())?;
        let rows=rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        Ok(rows)
        })?;
        Ok(json!({"records":rows,"bytes":super::dir_size(&root)}))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn clear_player_history_cache(app:tauri::AppHandle,id:String)->Result<(),String>{
    if id.len()>300||!id.contains(':'){return Err("无效的玩家缓存".into());}
    let root=root(&app)?;
    tauri::async_runtime::spawn_blocking(move||{
        // Other players and shared details/images remain available.
        with_db(&root,"clear",|db|db.execute("DELETE FROM records WHERE id=?1 AND kind IN ('history','profile','view')",params![id]).map_err(|e|e.to_string()))?;
        Ok(())
    }).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub fn open_history_cache_folder(app:tauri::AppHandle)->Result<(),String>{
    let root=root(&app)?;
    std::fs::create_dir_all(&root).map_err(|e|e.to_string())?;
    super::open_url(root.to_string_lossy().into_owned())
}
