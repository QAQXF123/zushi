//! Persistent derived files only; original skins and game resources are never modified here.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{hash_map::DefaultHasher, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const RECORD: &str = ".zushi-cache.json";
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Stamp { path: String, size: u64, modified: (i64,i64), changed: (i64,i64), inode: u64 }
fn stamp(path:&Path, relative:String)->Result<Stamp,String>{
    let meta=fs::metadata(path).map_err(|e|format!("无法读取 {}：{e}",path.display()))?;
    Ok(Stamp{path:relative,size:meta.len(),modified:(meta.mtime(),meta.mtime_nsec()),changed:(meta.ctime(),meta.ctime_nsec()),inode:meta.ino()})
}
fn inventory(root:&Path, skip_record:bool)->Result<Vec<Stamp>,String>{
    fn walk(path:&Path,root:&Path,skip:bool,output:&mut Vec<Stamp>)->Result<(),String>{
        if path.is_dir(){
            for entry in fs::read_dir(path).map_err(|e|e.to_string())? {
                let entry=entry.map_err(|e|e.to_string())?;
                if entry.file_type().map_err(|e|e.to_string())?.is_symlink(){return Err(format!("缓存源目录不支持符号链接：{}",entry.path().display()));}
                if skip&&entry.file_name()==RECORD{continue;}
                walk(&entry.path(),root,skip,output)?;
            }
        }else{output.push(stamp(path,path.strip_prefix(root).unwrap_or(path).to_string_lossy().into())?);}
        Ok(())
    }
    let mut files=Vec::new();walk(root,root,skip_record,&mut files)?;files.sort_by(|a,b|a.path.cmp(&b.path));Ok(files)
}
fn read_json(path:&Path)->Option<Value>{serde_json::from_slice(&fs::read(path).ok()?).ok()}
pub(super) fn write_json(path:&Path,value:&Value)->Result<(),String>{
    let temp=path.with_extension("json.pending");
    fs::write(&temp,serde_json::to_vec(value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    fs::rename(temp,path).map_err(|e|e.to_string())
}
fn key(value:&Value)->String{let mut hash=DefaultHasher::new();value.to_string().hash(&mut hash);format!("{:016x}",hash.finish())}
pub(super) fn context(binary:&Path,game:&Path)->Result<Value,String>{
    let game=fs::canonicalize(game).map_err(|e|e.to_string())?;
    let mut version=inventory(&game.join("DATA/FINAL"),false)?;
    for name in ["content-metadata.json","code-metadata.json","compat-version-metadata.json"]{
        let path=game.join(name);if path.is_file(){version.push(stamp(&path,name.into())?);}
    }
    Ok(json!({"format":1,"game":game,"resources":version,"tool":stamp(binary,binary.to_string_lossy().into())?}))
}
#[derive(Clone)]
pub(super) struct Import {pub key:String,pub source:PathBuf,signature:Value}
pub(super) struct Plan {pub root:PathBuf,pub imports:Vec<Import>,pub missing:Vec<Import>,pub cached:usize,pub context_changed:bool}
pub(super) fn prepare(base:&Path,context:&Value,paths:&[String])->Result<Plan,String>{
    let root=base.join("apply-cache/imported");fs::create_dir_all(&root).map_err(|e|e.to_string())?;
    let context_file=base.join("apply-cache/context.json");
    let previous=read_json(&context_file);
    let context_changed=previous.as_ref()!=Some(context);
    if context_changed{
        fs::remove_dir_all(&root).map_err(|e|e.to_string())?;fs::create_dir_all(&root).map_err(|e|e.to_string())?;
        if !previous.as_ref().map(|old|old["format"]==context["format"]&&old["game"]==context["game"]&&old["resources"]==context["resources"]).unwrap_or(false){
            let _=fs::remove_file(base.join("overlay-cache.json"));
        }
        write_json(&context_file,context)?;
    }
    // Interrupted subprocesses may leave temporary directories; only completed entries survive.
    for entry in fs::read_dir(&root).map_err(|e|e.to_string())?{
        let entry=entry.map_err(|e|e.to_string())?;
        if entry.file_name().to_string_lossy().contains('.') {let _=fs::remove_dir_all(entry.path());}
    }
    let mut imports=Vec::new();let mut missing=Vec::new();let mut seen=HashSet::new();
    for path in paths{
        let source=fs::canonicalize(path).map_err(|e|format!("皮肤文件不可用 {path}：{e}"))?;
        if !seen.insert(source.clone()){continue;}
        if source.to_string_lossy().contains(['\n','\r','\t']){return Err("皮肤文件路径不能包含换行或制表符".into());}
        let signature=json!({"source":source,"files":inventory(&source,false)?});
        let import=Import{key:key(&signature),source,signature};
        let dir=root.join(&import.key);
        let valid=read_json(&dir.join(RECORD)).map(|record|{
            record["signature"]==import.signature&&dir.join("META/info.json").is_file()&&
            inventory(&dir,true).ok().and_then(|files|serde_json::to_value(files).ok()).as_ref()==record.get("files")
        }).unwrap_or(false);
        if !valid{missing.push(import.clone());}
        imports.push(import);
    }
    Ok(Plan{cached:imports.len()-missing.len(),root,imports,missing,context_changed})
}
impl Plan{
    pub fn manifest(&self,path:&Path)->Result<(),String>{
        let text=self.missing.iter().map(|job|format!("{}.pending\t{}\n",job.key,job.source.display())).collect::<String>();
        fs::write(path,text).map_err(|e|e.to_string())
    }
    pub fn finish(&self,index:usize)->Result<(),String>{
        let job=self.missing.get(index).ok_or("无效的导入进度")?;
        let pending=self.root.join(format!("{}.pending",job.key));
        if !pending.join("META/info.json").is_file(){return Err("皮肤导入结果不完整".into());}
        // A skin replaced while importing must not be published as a valid cache entry.
        if json!({"source":job.source,"files":inventory(&job.source,false)?})!=job.signature{return Err("皮肤文件在导入期间发生变化，请重试".into());}
        write_json(&pending.join(RECORD),&json!({"signature":job.signature,"files":inventory(&pending,true)?}))?;
        let target=self.root.join(&job.key);if target.exists(){fs::remove_dir_all(&target).map_err(|e|e.to_string())?;}
        fs::rename(pending,target).map_err(|e|e.to_string())
    }
    fn selection(&self)->Vec<&str>{self.imports.iter().map(|job|job.key.as_str()).collect()}
    pub fn mods_arg(&self)->String{format!("--mods:{}",self.selection().join("/"))}
    pub fn reusable_overlay(&self,base:&Path)->bool{
        if self.context_changed{return false;}
        read_json(&base.join("overlay-cache.json")).map(|record|{
            record["mods"]==json!(self.selection())&&inventory(&base.join("overlay"),false).ok()
                .filter(|files|!files.is_empty()).and_then(|files|serde_json::to_value(files).ok()).as_ref()==record.get("files")
        }).unwrap_or(false)
    }
    pub fn publish_overlay(&self,base:&Path)->Result<(),String>{
        let overlay=base.join("overlay");let previous=base.join("overlay-previous");
        let _=fs::remove_file(base.join("overlay-cache.json"));
        if previous.exists(){fs::remove_dir_all(&previous).map_err(|e|e.to_string())?;}
        if overlay.exists(){fs::rename(&overlay,&previous).map_err(|e|e.to_string())?;}
        if let Err(error)=fs::rename(base.join("overlay-next"),&overlay){
            if previous.exists(){let _=fs::rename(&previous,&overlay);}
            return Err(error.to_string());
        }
        write_json(&base.join("overlay-cache.json"),&json!({"mods":self.selection(),"files":inventory(&overlay,false)?}))?;
        let _=fs::remove_dir_all(previous);Ok(())
    }
    pub fn prune(&self){
        // Keep every selected skin. Bound the rest to 96 entries / 2 GiB, oldest first.
        let selected:HashSet<_>=self.imports.iter().map(|job|job.key.as_str()).collect();
        let mut unused=Vec::new();
        if let Ok(entries)=fs::read_dir(&self.root){for entry in entries.flatten(){
            let name=entry.file_name().to_string_lossy().into_owned();if selected.contains(name.as_str()){continue;}
            let touched=entry.metadata().and_then(|m|m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            let size=super::dir_size(&entry.path());unused.push((touched,entry.path(),size));
        }}
        unused.sort_by_key(|entry|entry.0);
        let mut bytes:u64=unused.iter().map(|entry|entry.2).sum();let mut count=unused.len();
        for (_,path,size)in unused{if count<=96&&bytes<=2*1024*1024*1024{break;}if fs::remove_dir_all(path).is_ok(){count-=1;bytes=bytes.saturating_sub(size);}}
    }
}

/// APFS clones have independent inodes and copy-on-write blocks. Hard links must
/// never be used: rebuilding a changed WAD would corrupt the previous overlay.
pub(super) fn seed_overlay(base:&Path){
    // Only seed from a completed, unchanged overlay; a partial/corrupt previous
    // output must not be accepted just because its embedded WAD header matches.
    let valid=read_json(&base.join("overlay-cache.json")).map(|record|{
        inventory(&base.join("overlay"),false).ok().and_then(|files|serde_json::to_value(files).ok()).as_ref()==record.get("files")
    }).unwrap_or(false);
    if !valid{return;}

    #[cfg(target_os="macos")]
    fn clone_tree(source:&Path,target:&Path){
        use std::os::unix::ffi::OsStrExt;
        if fs::create_dir_all(target).is_err(){return;}
        let Ok(entries)=fs::read_dir(source)else{return;};
        for entry in entries.flatten(){
            let Ok(kind)=entry.file_type()else{continue;};
            let destination=target.join(entry.file_name());
            if kind.is_dir(){clone_tree(&entry.path(),&destination);}
            else if kind.is_file(){
                let source=std::ffi::CString::new(entry.path().as_os_str().as_bytes());
                let destination_c=std::ffi::CString::new(destination.as_os_str().as_bytes());
                if let (Ok(source),Ok(destination_c))=(source,destination_c){
                    // Unsupported filesystems simply leave this file for mkoverlay to create.
                    if unsafe{libc::clonefile(source.as_ptr(),destination_c.as_ptr(),0)}!=0{let _=fs::remove_file(destination);}
                }
            }
        }
    }
    #[cfg(target_os="macos")]
    clone_tree(&base.join("overlay"),&base.join("overlay-next"));
    #[cfg(not(target_os="macos"))]
    let _=base;
}

pub(super) fn layout_dir(base:&Path)->PathBuf{base.parent().unwrap_or(base).join("Zushi/layout-cache")}
