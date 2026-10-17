use crate::state::{AppState, AppStatus};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

const DEFAULT_GAME_PATH: &str = "/Applications/League of Legends.app/Contents/LoL/Game";

#[derive(Serialize, Deserialize)]
struct GamePathConfig {
    game_path: String,
}

/// Check the game directory itself, rather than accepting a missing app bundle.
fn is_valid_game_dir(path: &str) -> bool {
    Path::new(path).join("LeagueofLegends.app").is_dir()
}

fn resolve_game_path(raw: &str) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    let candidates = [
        format!("{}/Contents/LoL/Game", raw),
        raw.to_string(),
        format!("{}/Game", raw),
    ];
    candidates.iter().find_map(|candidate| {
        if !is_valid_game_dir(candidate) {
            return None;
        }
        Path::new(candidate).canonicalize().ok()
            .map(|path| path.to_string_lossy().into_owned())
    })
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir()
        .map(|dir| dir.join("game-path.json"))
        .map_err(|e| e.to_string())
}

fn load_saved_path(config: &Path) -> Option<String> {
    let bytes = fs::read(config).ok()?;
    let saved: GamePathConfig = serde_json::from_slice(&bytes).ok()?;
    resolve_game_path(&saved.game_path)
}

fn save_path(config: &Path, game_path: &str) -> Result<(), String> {
    if let Some(parent) = config.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot save game path: {e}"))?;
    }
    let bytes = serde_json::to_vec(&GamePathConfig { game_path: game_path.into() })
        .map_err(|e| e.to_string())?;
    let temporary = config.with_extension("json.tmp");
    let result = fs::write(&temporary, bytes)
        .and_then(|_| fs::rename(&temporary, config))
        .map_err(|e| format!("Cannot save game path: {e}"));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn discover_game_path(config: &Path, default_path: &str, volumes: &Path) -> Option<String> {
    // A manually chosen installation always has priority over automatic detection.
    load_saved_path(config)
        .or_else(|| resolve_game_path(default_path))
        .or_else(|| {
            fs::read_dir(volumes).ok()?.flatten().find_map(|volume| {
                let mount = volume.path();
                [mount.join("League of Legends.app"), mount.join("Applications/League of Legends.app")]
                    .iter().find_map(|path| resolve_game_path(&path.to_string_lossy()))
            })
        })
}

#[tauri::command]
pub fn detect_game_path(app: AppHandle, state: State<'_, Arc<Mutex<AppState>>>) -> Result<Option<String>, String> {
    let config = config_path(&app)?;
    let path = discover_game_path(&config, DEFAULT_GAME_PATH, Path::new("/Volumes"));
    if let Some(ref path) = path {
        // Automatic detection can still open the app if the config cannot be written.
        if let Err(error) = save_path(&config, path) {
            eprintln!("[zushi] {error}");
        }
    }
    let mut app_state = state.lock().map_err(|e| e.to_string())?;
    app_state.game_path = path.clone();
    app_state.status = if path.is_some() { AppStatus::GameDetected } else { AppStatus::GameNotFound };
    Ok(path)
}

#[tauri::command]
pub fn validate_game_path(path: String) -> Result<Option<String>, String> {
    Ok(resolve_game_path(&path))
}

#[tauri::command]
pub fn set_game_path(app: AppHandle, path: String, state: State<'_, Arc<Mutex<AppState>>>) -> Result<(), String> {
    let validated = resolve_game_path(&path)
        .ok_or_else(|| "Invalid game path: LeagueofLegends.app not found".to_string())?;
    let mut app_state = state.lock().map_err(|e| e.to_string())?;
    save_path(&config_path(&app)?, &validated)?;
    app_state.game_path = Some(validated);
    app_state.status = AppStatus::GameDetected;
    Ok(())
}

#[tauri::command]
pub fn get_game_path(state: State<'_, Arc<Mutex<AppState>>>) -> Result<Option<String>, String> {
    let app_state = state.lock().map_err(|e| e.to_string())?;
    Ok(app_state.game_path.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn directory() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zushi-path-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn game(root: &Path) -> String {
        let path = root.join("Contents/LoL/Game");
        fs::create_dir_all(path.join("LeagueofLegends.app")).unwrap();
        path.canonicalize().unwrap().to_string_lossy().into_owned()
    }

    #[test]
    fn chosen_path_survives_restart_and_overrides_default() {
        let dir = directory();
        let custom = game(&dir.join("external/League of Legends.app"));
        let default = game(&dir.join("default/League of Legends.app"));
        let config = dir.join("settings/game-path.json");
        save_path(&config, &custom).unwrap();
        assert_eq!(discover_game_path(&config, &default, &dir.join("volumes")), Some(custom));
        assert!(!config.with_extension("json.tmp").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn changing_path_replaces_previous_selection() {
        let dir = directory();
        let first = game(&dir.join("first"));
        let second = game(&dir.join("second"));
        let config = dir.join("game-path.json");
        save_path(&config, &first).unwrap();
        save_path(&config, &second).unwrap();
        assert_eq!(load_saved_path(&config), Some(second));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn detects_external_volume_without_previous_setup() {
        let dir = directory();
        let external = game(&dir.join("volumes/out_device/League of Legends.app"));
        assert_eq!(discover_game_path(&dir.join("missing.json"), "/missing", &dir.join("volumes")), Some(external));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unavailable_saved_path_is_not_accepted_or_erased() {
        let dir = directory();
        let config = dir.join("game-path.json");
        save_path(&config, "/missing/game").unwrap();
        let before = fs::read(&config).unwrap();
        assert_eq!(discover_game_path(&config, "/missing", &dir.join("volumes")), None);
        assert_eq!(fs::read(&config).unwrap(), before);
        fs::write(&config, b"invalid json").unwrap();
        assert_eq!(load_saved_path(&config), None);
        fs::remove_dir_all(dir).unwrap();
    }
}
