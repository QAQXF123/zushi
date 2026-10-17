use crate::state::{AppState, PatcherStatus};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use super::{apply_cache,apply_trace::Trace};
use serde_json::json;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use tauri::{AppHandle, Manager, State};

/// Serializes patcher setup (kill-old → import → mkoverlay → spawn → record pid).
/// Two live mod-tools tracers on the same game task port make the kernel SIGSEGV
/// the new one, so only one apply may be in its setup phase at a time. Held until
/// just before the long monitoring wait, then released.
fn apply_setup_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn work_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("failed to get app data dir");
    fs::create_dir_all(&dir).ok();
    dir
}

fn sidecar_path(_app: &AppHandle) -> PathBuf {
    let triple = if cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else {
        "x86_64-apple-darwin"
    };

    // Production: Tauri bundles the sidecar as "mod-tools" next to the app binary
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bin = dir.join("mod-tools");
            if bin.exists() {
                return bin;
            }
        }
    }

    // Dev: binary lives in src-tauri/binaries/ with the target triple suffix
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("mod-tools-{}", triple))
}

fn run_mod_tools(binary: &PathBuf, args: &[String], trace:&Trace) -> Result<String, String> {
    let _span=trace.span("helper_mkoverlay");
    let mut child=Command::new(binary).args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|e.to_string())?;
    let stderr=child.stderr.take();let trace_err=trace.clone();
    let errors=std::thread::spawn(move||{
        let mut lines=std::collections::VecDeque::new();
        if let Some(stderr)=stderr{for line in BufReader::new(stderr).lines().map_while(Result::ok){trace_err.event("helper_stderr",json!({"message":line}));if lines.len()==40{lines.pop_front();}lines.push_back(line);}}
        lines.into_iter().collect::<Vec<_>>().join("\n")
    });
    let mut lines=std::collections::VecDeque::new();
    if let Some(stdout)=child.stdout.take(){for line in BufReader::new(stdout).lines().map_while(Result::ok){
        trace.event("helper_stdout",json!({"message":line}));if lines.len()==40{lines.pop_front();}lines.push_back(line);
    }}
    let status=child.wait().map_err(|e|e.to_string())?;let stderr=errors.join().unwrap_or_default();
    let stdout=lines.into_iter().collect::<Vec<_>>().join("\n");
    if !status.success(){return Err(format!("mod-tools failed ({status}): {stdout}\n{stderr}"));}
    Ok(stdout)
}

#[tauri::command]
pub fn apply_skin(
    app: AppHandle,
    state: State<'_, Arc<Mutex<AppState>>>,
    zip_path: String,
) -> Result<String, String> {
    start_apply(app, vec![zip_path], state.inner().clone())
}

#[tauri::command]
pub fn apply_skins(
    app: AppHandle,
    state: State<'_, Arc<Mutex<AppState>>>,
    zip_paths: Vec<String>,
) -> Result<String, String> {
    start_apply(app, zip_paths, state.inner().clone())
}

/// Validates inputs, sets status to Importing, spawns a background thread
/// for the heavy work, and returns immediately so the UI stays responsive.
fn start_apply(
    app: AppHandle,
    zip_paths: Vec<String>,
    state: Arc<Mutex<AppState>>,
) -> Result<String, String> {
    if zip_paths.is_empty() {
        return Err("No skins selected".to_string());
    }

    let game_path = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.game_path
            .clone()
            .ok_or_else(|| "Game path not set".to_string())?
    };

    let binary = sidecar_path(&app);
    if !binary.exists() {
        return Err(format!("mod-tools not found at {:?}", binary));
    }

    // Bump the generation up front so any apply already waiting for the setup
    // lock knows it has been superseded and can bail without spawning a patcher.
    let gen = {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.patcher_gen += 1;
        s.patcher_status = PatcherStatus::Importing;
        s.patcher_gen
    };

    let base = work_dir(&app);
    let trace=Trace::new(&base);trace.event("apply_requested",json!({"skins":zip_paths.len()}));
    std::thread::spawn(move || {
        let waiting=trace.span("queue_wait");
        // Serialize the whole setup so two patchers can never run at once. This
        // blocks until any in-flight apply has finished spawning and *recorded*
        // its pid — only then can we see and kill it. Released before monitoring.
        let setup_guard = apply_setup_lock().lock().unwrap_or_else(|e| e.into_inner());
        drop(waiting);

        // A newer apply superseded us while we waited for the lock — let it win.
        if let Ok(s) = state.lock() {
            if s.patcher_gen != gen {
                return;
            }
        }

        // Stop the currently-tracked patcher: close its stdin (graceful abort),
        // then confirm it is fully dead before we touch the game. pid is read
        // here (under the setup lock) so it reflects the real running patcher.
        let stopping=trace.span("stop_previous_patcher");
        let old_pid = match state.lock() {
            Ok(mut s) => {
                if let Some(mut pipe) = s.patcher_stdin.take() {
                    pipe.write_all(b"\n").ok();
                    drop(pipe);
                }
                s.patcher_pid.take()
            }
            Err(_) => None,
        };
        if let Some(pid) = old_pid {
            let pid_i = pid as i32;
            // kill(pid, 0) probes existence: 0 while alive, -1 (ESRCH) once gone.
            let wait_gone = |timeout_ms: u64| -> bool {
                let deadline =
                    std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
                loop {
                    if unsafe { libc::kill(pid_i, 0) } != 0 {
                        return true;
                    }
                    if std::time::Instant::now() >= deadline {
                        return false;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            };
            if !wait_gone(3000) {
                unsafe { libc::kill(pid_i, libc::SIGTERM) };
                if !wait_gone(1500) {
                    unsafe { libc::kill(pid_i, libc::SIGKILL) };
                    wait_gone(2000);
                }
            }
        }

        drop(stopping);
        if let Err(e) =
            do_apply_skins_bg(binary, base, game_path, zip_paths, state.clone(), gen, setup_guard,trace.clone())
        {
            trace.event("apply_error",json!({"error":e}));
            if let Ok(mut s) = state.lock() {
                if s.patcher_gen == gen {
                    s.patcher_status = PatcherStatus::Error(e);
                    s.patcher_stdin = None;
                    s.patcher_pid = None;
                }
            }
        }
    });

    Ok("Patcher starting".to_string())
}

/// A single helper process shares the game index for all cache misses.
fn import_batch(binary:&PathBuf,manifest:&std::path::Path,game:&str,plan:&apply_cache::Plan,state:&Arc<Mutex<AppState>>,gen:u64,trace:&Trace)->Result<bool,String>{
    let _span=trace.span("batch_import");
    let mut child=Command::new(binary).arg("import-list").arg(manifest).arg(&plan.root)
        .arg(format!("--game:{game}")).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|e.to_string())?;
    // Progress has its own stream, so asynchronous helper logs cannot split protocol lines.
    let stdout=child.stdout.take();let trace_logs=trace.clone();
    let logs=std::thread::spawn(move||{
        let mut tail=std::collections::VecDeque::new();
        if let Some(stdout)=stdout{for line in BufReader::new(stdout).lines().map_while(Result::ok){trace_logs.event("import_stdout",json!({"message":line}));if tail.len()==20{tail.pop_front();}tail.push_back(line);}}
        tail.into_iter().collect::<Vec<_>>().join("\n")
    });
    let mut errors=std::collections::VecDeque::new();
    let mut cancelled=false;let mut failure=None;let mut completed=0;
    let progress=child.stderr.take().ok_or("无法读取批量导入进度")?;
    {
        let mut s=state.lock().map_err(|e|e.to_string())?;
        if s.patcher_gen!=gen{cancelled=true;let _=child.kill();}
        else{s.patcher_status=PatcherStatus::ImportingSkins{current:plan.cached,total:plan.imports.len(),cached:plan.cached};}
    }
    for line in BufReader::new(progress).lines(){
        let line=match line{Ok(line)=>line,Err(error)=>{failure=Some(error.to_string());let _=child.kill();break;}};
        let current=state.lock().map(|s|s.patcher_gen==gen).unwrap_or(false);
        if !current{cancelled=true;let _=child.kill();break;}
        if let Some(index)=line.strip_prefix("ImportProgress: ").and_then(|s|s.parse::<usize>().ok()){
            if index!=completed+1||index>plan.missing.len(){failure=Some("批量导入进度无效".into());let _=child.kill();break;}
            if let Err(error)=plan.finish(index-1){failure=Some(error);let _=child.kill();break;}
            completed=index;trace.event("import_complete",json!({"index":index,"total":plan.missing.len()}));
            if let Ok(mut s)=state.lock(){if s.patcher_gen==gen{s.patcher_status=PatcherStatus::ImportingSkins{current:plan.cached+completed,total:plan.imports.len(),cached:plan.cached};}}
        }else{if errors.len()==30{errors.pop_front();}errors.push_back(line);}
    }
    let status=child.wait().map_err(|e|e.to_string())?;
    let log_tail=logs.join().unwrap_or_default();
    let detail=format!("{}\n{}",log_tail,errors.into_iter().collect::<Vec<_>>().join("\n"));
    if cancelled{return Ok(false);}
    if let Some(error)=failure{return Err(error);}
    if !status.success(){return Err(format!("批量导入失败：{detail}"));}
    if completed!=plan.missing.len(){return Err("批量导入结果不完整，请重试".into());}
    Ok(true)
}

fn do_apply_skins_bg(
    binary: PathBuf,
    base: PathBuf,
    game_path: String,
    zip_paths: Vec<String>,
    state: Arc<Mutex<AppState>>,
    gen: u64,
    setup_guard: MutexGuard<'static, ()>,
    trace:Trace,
) -> Result<(), String> {
    let started=std::time::Instant::now();
    let preparation=trace.span("preparation_total");
    let overlay_dir=base.join("overlay");
    let config_file=base.join("config");
    {
        let mut s=state.lock().map_err(|e|e.to_string())?;
        if s.patcher_gen!=gen{return Ok(());}
        s.patcher_status=PatcherStatus::CheckingCache;
    }
    let context={let _s=trace.span("game_fingerprint");apply_cache::context(&binary,std::path::Path::new(&game_path))?};
    let plan={let _s=trace.span("cache_validation");apply_cache::prepare(&base,&context,&zip_paths)?};
    let reused_overlay={let _s=trace.span("overlay_validation");plan.reusable_overlay(&base)};
    trace.event("cache_result",json!({"skins":plan.imports.len(),"cached":plan.cached,"missing":plan.missing.len(),"contextChanged":plan.context_changed,"overlayReused":reused_overlay}));
    eprintln!("[zushi] apply cache: {} skins, {} cached, overlay reusable={}",plan.imports.len(),plan.cached,reused_overlay);
    if !reused_overlay {
        if !plan.missing.is_empty(){
            let manifest=base.join("apply-cache/import-list.txt");plan.manifest(&manifest)?;
            let result=import_batch(&binary,&manifest,&game_path,&plan,&state,gen,&trace);
            let _=fs::remove_file(manifest);
            if !result?{return Ok(());}
        }
        {
            let mut s=state.lock().map_err(|e|e.to_string())?;
            if s.patcher_gen!=gen{return Ok(());}
            s.patcher_status=PatcherStatus::BuildingOverlay;
        }
        let next=base.join("overlay-next");
        if next.exists(){fs::remove_dir_all(&next).map_err(|e|e.to_string())?;}
        {let _s=trace.span("clone_previous_overlay");apply_cache::seed_overlay(&base);}
        run_mod_tools(&binary,&[
            "mkoverlay".into(),plan.root.to_string_lossy().into(),next.to_string_lossy().into(),
            format!("--game:{}",game_path),plan.mods_arg(),format!("--repair-cache:{}",apply_cache::layout_dir(&base).display()),
        ],&trace).map_err(|error|if error.to_lowercase().contains("conflict"){
            "选中的皮肤或自定义模组存在资源冲突，请取消冲突项再应用。".into()
        }else{error})?;
        if state.lock().map_err(|e|e.to_string())?.patcher_gen!=gen{return Ok(());}
        let current_context={let _s=trace.span("game_fingerprint_recheck");apply_cache::context(&binary,std::path::Path::new(&game_path))?};
        if current_context!=context{
            return Err("游戏资源在准备期间发生变化，请等游戏更新完成后重新应用。".into());
        }
        {let _s=trace.span("publish_overlay");plan.publish_overlay(&base)?;}
    } else {
        if let Ok(mut s)=state.lock(){if s.patcher_gen==gen{s.patcher_status=PatcherStatus::ReusingOverlay;}}
    }
    eprintln!("[zushi] skin preparation finished in {:.2}s",started.elapsed().as_secs_f64());
    fs::write(&config_file, "").map_err(|e| e.to_string())?;
    // Prune only derived, unselected entries; currently selected skins remain cached.
    if !plan.missing.is_empty(){let _s=trace.span("prune_cache");plan.prune();}
    drop(preparation);trace.event("ready_waiting_for_game",json!({"prepareMs":started.elapsed().as_millis()}));
    if state.lock().map_err(|e|e.to_string())?.patcher_gen!=gen{return Ok(());}

    // Step 3: Run patcher
    {
        if let Ok(mut s) = state.lock() {
            if s.patcher_gen == gen {
                s.patcher_status = PatcherStatus::WaitingForGame;
            }
        }
    }

    let overlay_str = overlay_dir.to_string_lossy().to_string();
    let config_str = config_file.to_string_lossy().to_string();
    let game_arg = format!("--game:{}", game_path);

    let mut child = Command::new(&binary)
        .args([
            "runoverlay",
            &overlay_str,
            &config_str,
            &game_arg,
            "--opts:none",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start patcher: {}", e))?;

    // Record pid/stdin unconditionally (even if a newer apply just superseded us
    // while we held the setup lock): a superseding apply must be able to find and
    // kill this patcher. The generation guard elsewhere keeps stale status/cleanup
    // from clobbering the newer patcher.
    let child_pid = child.id();
    let stdin = child.stdin.take();
    if let Ok(mut s) = state.lock() {
        if s.patcher_gen!=gen {
            drop(stdin);
            let _=child.kill();let _=child.wait();
            return Ok(());
        }
        s.patcher_stdin = stdin;
        s.patcher_pid = Some(child_pid);
    }

    // Setup is done and the pid is recorded — release the lock so a queued apply
    // can now proceed (it will kill this patcher first). Everything below is just
    // long-running monitoring.
    drop(setup_guard);

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let state_arc = state.clone();let trace_out=trace.clone();
    let stdout_thread = std::thread::spawn(move || {
        let mut stage_started=std::time::Instant::now();
        let mut stage_name=String::from("helper_start");
        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                trace_out.event("patcher_stdout",json!({"message":line}));
                eprintln!("[zushi] mod-tools: {}", line);
                if let Some(status_msg) = line.strip_prefix("Status: ") {
                    trace_out.event("patcher_stage",json!({"stage":status_msg,"previousStage":stage_name,"previousDurationMs":stage_started.elapsed().as_millis()}));
                    stage_started=std::time::Instant::now();stage_name=status_msg.into();
                    let new_status = match status_msg {
                        "Waiting for league match to start" => Some(PatcherStatus::WaitingForGame),
                        "Found League" => Some(PatcherStatus::FoundGame),
                        "Scanning" | "Wait initialized" | "Saving" | "Wait patchable" => Some(PatcherStatus::Scanning),
                        "Patching" => Some(PatcherStatus::Patching),
                        "Waiting for exit" => Some(PatcherStatus::InGame),
                        "League exited" => Some(PatcherStatus::GameExited),
                        _ => None,
                    };
                    if let Some(status) = new_status {
                        if let Ok(mut s) = state_arc.lock() {
                            if s.patcher_gen == gen {
                                s.patcher_status = status;
                            }
                        }
                    }
                }
            }
        }
    });

    let trace_err=trace.clone();
    let stderr_thread = std::thread::spawn(move || {
        if let Some(err) = stderr {
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                trace_err.event("patcher_stderr",json!({"message":line}));
                eprintln!("[zushi] mod-tools err: {}", line);
            }
        }
    });

    let exit_status = child
        .wait()
        .map_err(|e| format!("Failed to wait for patcher: {}", e))?;
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();

    if let Ok(mut s) = state.lock() {
        if s.patcher_gen == gen {
            if !exit_status.success() {
                use std::os::unix::process::ExitStatusExt;
                let detail = if let Some(code) = exit_status.code() {
                    format!("exit code {}", code)
                } else if let Some(sig) = exit_status.signal() {
                    let name = match sig {
                        1 => "SIGHUP", 2 => "SIGINT", 3 => "SIGQUIT", 6 => "SIGABRT",
                        9 => "SIGKILL", 10 => "SIGBUS", 11 => "SIGSEGV", 13 => "SIGPIPE",
                        15 => "SIGTERM", _ => "?",
                    };
                    format!("killed by signal {} ({})", sig, name)
                } else {
                    "unknown".to_string()
                };
                eprintln!("[zushi] mod-tools runoverlay exited: {}", detail);
                s.patcher_status =
                    PatcherStatus::Error(format!("Patcher exited unexpectedly ({})", detail));
            } else {
                s.patcher_status = PatcherStatus::Idle;
            }
            s.patcher_stdin = None;
            s.patcher_pid = None;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn stop_patcher(state: State<'_, Arc<Mutex<AppState>>>) -> Result<(), String> {
    let stdin = {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.patcher_gen+=1;
        s.patcher_stdin.take()
    };

    if let Some(mut pipe) = stdin {
        pipe.write_all(b"\n").ok();
        drop(pipe);
    }

    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.patcher_status = PatcherStatus::Idle;
    Ok(())
}

#[tauri::command]
pub fn get_patcher_status(state: State<'_, Arc<Mutex<AppState>>>) -> Result<PatcherStatus, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok(s.patcher_status.clone())
}

#[tauri::command]
pub fn get_work_dir_size(app: AppHandle) -> Result<u64, String> {
    let base = work_dir(&app);
    let installed = dir_size(&base.join("installed"));
    let overlay = dir_size(&base.join("overlay"));
    let cache = dir_size(&base.join("apply-cache"));
    let pending = dir_size(&base.join("overlay-next")) + dir_size(&base.join("overlay-previous"));
    Ok(installed + overlay + cache + pending + dir_size(&apply_cache::layout_dir(&base)))
}

#[tauri::command]
pub fn clear_work_dir(
    app: AppHandle,
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<(), String> {
    let _setup=apply_setup_lock().try_lock().map_err(|_|"正在准备皮肤，请先停止应用后再清理缓存".to_string())?;
    {
        let s=state.lock().map_err(|e|e.to_string())?;
        if s.patcher_stdin.is_some()||!matches!(s.patcher_status,PatcherStatus::Idle|PatcherStatus::Error(_)){
            return Err("请先停止应用后再清理缓存".into());
        }
    }
    let base=work_dir(&app);
    for name in ["installed","overlay","apply-cache","overlay-next","overlay-previous"]{
        let path=base.join(name);if path.exists(){fs::remove_dir_all(path).map_err(|e|e.to_string())?;}
    }
    let layouts=apply_cache::layout_dir(&base);if layouts.exists(){fs::remove_dir_all(layouts).map_err(|e|e.to_string())?;}
    for name in ["config","overlay-cache.json"]{
        let path=base.join(name);if path.exists(){fs::remove_file(path).map_err(|e|e.to_string())?;}
    }
    Ok(())
}

use super::dir_size;

#[tauri::command]
pub fn open_apply_log(app:AppHandle)->Result<(),String>{
    let base=work_dir(&app);let trace=Trace::new(&base);trace.event("log_opened",json!({}));
    super::open_url(base.join("logs/skin-apply.jsonl").to_string_lossy().into_owned())
}
