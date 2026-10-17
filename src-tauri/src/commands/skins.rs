use crate::state::DownloadedSkin;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::time::Duration;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadItem {
    pub url: String,
    pub champion_name: String,
    pub skin_name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    current: u32,
    total: u32,
    skin_name: String,
}

/// Skin names like "K/DA Kai'Sa" contain '/', which is a path separator.
/// Encode it for on-disk folder/file names and decode when reading back,
/// so the logical skin name stays intact everywhere else.
fn encode_path(s: &str) -> String {
    s.replace('/', "%2F")
}

fn decode_path(s: &str) -> String {
    s.replace("%2F", "/")
}

pub(super) fn skins_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let config = data.join("skin-storage.json");
    let saved = fs::read(&config).ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|json| json.get("directory").and_then(|v| v.as_str()).map(PathBuf::from));
    let dir = if let Some(saved) = saved {
        if !saved.is_dir() {
            return Err(format!("Skin library is unavailable: {}. Connect the external drive.", saved.display()));
        }
        saved
    } else {
        let mut libraries: Vec<PathBuf> = fs::read_dir("/Volumes").ok().into_iter().flatten()
            .filter_map(Result::ok)
            .map(|entry| entry.path().join("ZushiSkins"))
            .filter(|path| path.join(".zushi-library.json").is_file())
            .collect();
        libraries.sort();
        match libraries.into_iter().next() {
            Some(library) => {
                fs::create_dir_all(&data).map_err(|e| e.to_string())?;
                let bytes = serde_json::to_vec(&serde_json::json!({"directory": library})).map_err(|e| e.to_string())?;
                fs::write(config, bytes).map_err(|e| e.to_string())?;
                library
            }
            None => data.join("skins"),
        }
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub async fn get_local_skin_library(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let directory = skins_dir(&app)?;
    flatten(tauri::async_runtime::spawn_blocking(move || {
        let metadata = directory.join(".zushi-library.json");
        if !metadata.is_file() { return Ok(None); }
        let bytes = fs::read(metadata).map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).map(Some).map_err(|e| e.to_string())
    }).await)
}

/// Flatten a spawn_blocking result into our String error type.
fn flatten<T>(res: Result<Result<T, String>, impl std::fmt::Display>) -> Result<T, String> {
    match res {
        Ok(inner) => inner,
        Err(e) => Err(e.to_string()),
    }
}

// Bound both connection setup and the complete response body read.
fn download_file(url: &str, zip_path: &std::path::Path) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build();
    download_file_with_agent(url, zip_path, &agent)
}

fn download_file_with_agent(url: &str, zip_path: &std::path::Path, agent: &ureq::Agent) -> Result<(), String> {
    let response = agent.get(url).call()
        .map_err(|e| format!("Download failed: {e}"))?;
    let mut bytes = Vec::new();
    response.into_reader().read_to_end(&mut bytes)
        .map_err(|e| format!("Read failed: {e}"))?;
    if bytes.is_empty() {
        return Err("Downloaded file is empty".into());
    }
    // Publish only a complete file, so failed writes never appear as downloaded.
    let temporary = zip_path.with_extension("zip.part");
    let result = fs::write(&temporary, &bytes)
        .and_then(|_| fs::rename(&temporary, zip_path))
        .map_err(|e| format!("Write failed: {e}"));
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

/// Download a single skin zip. Runs blocking I/O on a background thread.
#[tauri::command]
pub async fn download_skin(
    app: AppHandle,
    url: String,
    champion_name: String,
    skin_name: String,
) -> Result<String, String> {
    let base = skins_dir(&app)?;
    flatten(
        tauri::async_runtime::spawn_blocking(move || {
            let skin_dir = base
                .join(encode_path(&champion_name))
                .join(encode_path(&skin_name));
            fs::create_dir_all(&skin_dir).map_err(|e| e.to_string())?;

            let zip_path = skin_dir.join(format!("{}.zip", encode_path(&skin_name)));

            // Also skip on disk: a stale UI list must not re-download an existing skin.
            if !fs::metadata(&zip_path).map(|meta| meta.is_file() && meta.len() > 0).unwrap_or(false) {
                download_file(&url, &zip_path)?;
            }

            Ok(zip_path.to_string_lossy().into_owned())
        })
        .await,
    )
}

/// Download multiple skins in one call. Runs entirely on a background thread,
/// emitting progress events so the UI stays responsive.
#[tauri::command]
pub async fn download_multiple_skins(
    app: AppHandle,
    items: Vec<DownloadItem>,
) -> Result<u32, String> {
    let base = skins_dir(&app)?;
    flatten(
        tauri::async_runtime::spawn_blocking(move || {
            let total = items.len() as u32;
            let mut success_count = 0u32;

            for (index, item) in items.iter().enumerate() {
                let skin_dir = base
                    .join(encode_path(&item.champion_name))
                    .join(encode_path(&item.skin_name));
                if fs::create_dir_all(&skin_dir).is_err() {
                    continue;
                }

                let zip_path = skin_dir.join(format!("{}.zip", encode_path(&item.skin_name)));

                let ok = download_file(&item.url, &zip_path).is_ok();

                if ok {
                    success_count += 1;
                }

                app.emit(
                    "download-progress",
                    DownloadProgress {
                        current: (index + 1) as u32,
                        total,
                        skin_name: item.skin_name.clone(),
                    },
                )
                .ok();
            }

            Ok(success_count)
        })
        .await,
    )
}

#[tauri::command]
pub async fn list_downloaded_skins(app: AppHandle) -> Result<Vec<DownloadedSkin>, String> {
    let base = skins_dir(&app)?;
    flatten(
        tauri::async_runtime::spawn_blocking(move || {
            let mut skins = Vec::new();

            let entries = match fs::read_dir(&base) {
                Ok(e) => e,
                Err(_) => return Ok(skins),
            };

            for champion_entry in entries.flatten() {
                if !champion_entry
                    .file_type()
                    .map(|t| t.is_dir())
                    .unwrap_or(false)
                {
                    continue;
                }
                let champion_dir_name = champion_entry.file_name().to_string_lossy().to_string();
                let champion_name = decode_path(&champion_dir_name);

                if let Ok(skin_entries) = fs::read_dir(champion_entry.path()) {
                    for skin_entry in skin_entries.flatten() {
                        if !skin_entry
                            .file_type()
                            .map(|t| t.is_dir())
                            .unwrap_or(false)
                        {
                            continue;
                        }
                        let skin_dir_name = skin_entry.file_name().to_string_lossy().to_string();
                        let zip_path = skin_entry.path().join(format!("{}.zip", &skin_dir_name));

                        if zip_path.exists() {
                            skins.push(DownloadedSkin {
                                champion_name: champion_name.clone(),
                                skin_name: decode_path(&skin_dir_name),
                                zip_path: zip_path.to_string_lossy().into_owned(),
                            });
                        }
                    }
                }
            }

            Ok(skins)
        })
        .await,
    )
}

#[tauri::command]
pub async fn delete_downloaded_skin(
    app: AppHandle,
    champion_name: String,
    skin_name: String,
) -> Result<(), String> {
    let base = skins_dir(&app)?;
    flatten(
        tauri::async_runtime::spawn_blocking(move || {
            let skin_dir = base
                .join(encode_path(&champion_name))
                .join(encode_path(&skin_name));
            if skin_dir.exists() {
                fs::remove_dir_all(&skin_dir).map_err(|e| e.to_string())?;
            }

            let champion_dir = base.join(encode_path(&champion_name));
            if champion_dir.exists() {
                if champion_dir
                    .read_dir()
                    .map(|mut d| d.next().is_none())
                    .unwrap_or(false)
                {
                    fs::remove_dir(&champion_dir).ok();
                }
            }

            Ok(())
        })
        .await,
    )
}

#[tauri::command]
pub async fn get_skins_dir_size(app: AppHandle) -> Result<u64, String> {
    let base = skins_dir(&app)?;
    flatten(
        tauri::async_runtime::spawn_blocking(move || Ok(dir_size(&base))).await,
    )
}

#[tauri::command]
pub async fn clear_all_skins(app: AppHandle) -> Result<(), String> {
    let base = skins_dir(&app)?;
    flatten(
        tauri::async_runtime::spawn_blocking(move || {
            if base.exists() {
                fs::remove_dir_all(&base).map_err(|e| e.to_string())?;
                fs::create_dir_all(&base).ok();
            }
            Ok(())
        })
        .await,
    )
}

use super::dir_size;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn output_path() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zushi-download-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&dir).unwrap();
        dir.join("skin.zip")
    }

    fn server(response: &'static [u8], delay: Duration) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).unwrap();
            std::thread::sleep(delay);
            let _ = stream.write_all(response);
        });
        (url, handle)
    }

    #[test]
    fn successful_download_is_published_without_partial_file() {
        let (url, server) = server(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nskin", Duration::ZERO);
        let path = output_path();
        download_file(&url, &path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"skin");
        assert!(!path.with_extension("zip.part").exists());
        server.join().unwrap();
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn empty_and_truncated_downloads_do_not_replace_existing_skin() {
        for response in [
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".as_slice(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nshort".as_slice(),
        ] {
            let (url, server) = server(response, Duration::ZERO);
            let path = output_path();
            fs::write(&path, b"existing").unwrap();
            assert!(download_file(&url, &path).is_err());
            assert_eq!(fs::read(&path).unwrap(), b"existing");
            server.join().unwrap();
            fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn stalled_response_times_out_without_creating_a_skin() {
        let (url, server) = server(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nskin", Duration::from_millis(250));
        let path = output_path();
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_millis(50)).build();
        assert!(download_file_with_agent(&url, &path, &agent).is_err());
        assert!(!path.exists());
        server.join().unwrap();
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
