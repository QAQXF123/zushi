//! Diagnostic logs contain patch preparation details only, never client authentication.
use serde_json::{json,Value};
use std::fs::{self,File,OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Arc,Mutex};
use std::time::{Instant,SystemTime,UNIX_EPOCH};
#[derive(Clone)]
pub(super) struct Trace {inner:Arc<Inner>}
struct Inner {file:Option<Mutex<File>>,start:Instant,id:u128}
pub(super) struct Span {trace:Trace,name:&'static str,start:Instant}
impl Trace {
    pub fn new(base:&Path)->Self{
        let dir=base.join("logs");let _=fs::create_dir_all(&dir);
        let path=dir.join("skin-apply.jsonl");
        if fs::metadata(&path).map(|m|m.len()>8*1024*1024).unwrap_or(false){let _=fs::rename(&path,dir.join("skin-apply.previous.jsonl"));}
        let file=OpenOptions::new().create(true).append(true).open(path).ok().map(Mutex::new);
        Self{inner:Arc::new(Inner{file,start:Instant::now(),id:SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()})}
    }
    pub fn event(&self,name:&str,detail:Value){
        let row=json!({"timeMs":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),"applyId":self.inner.id,"elapsedMs":self.inner.start.elapsed().as_millis(),"event":name,"detail":detail});
        if let Some(file)=&self.inner.file{if let Ok(mut file)=file.lock(){let _=writeln!(file,"{row}");let _=file.flush();}}
    }
    pub fn span(&self,name:&'static str)->Span{self.event(name,json!({"state":"start"}));Span{trace:self.clone(),name,start:Instant::now()}}
}
impl Drop for Span{fn drop(&mut self){self.trace.event(self.name,json!({"state":"end","durationMs":self.start.elapsed().as_millis()}));}}
