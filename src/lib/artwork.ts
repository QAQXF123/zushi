import { invoke } from "@tauri-apps/api/core";
const memory = new Map<string, string>(),
  pending = new Map<string, Promise<string>>();
type Job = { url: string; foreground: boolean; run: () => void };
const queue: Job[] = [];
let active = 0,
  prefetchActive = 0,
  bytes = 0,
  generation = 0;
const LIMIT = 48 * 1024 * 1024;
function pump() {
  while (active < 6 && queue.length) {
    let index = queue.findIndex((j) => j.foreground);
    if (index < 0) {
      if (prefetchActive >= 2) break;
      index = 0;
    }
    const job = queue.splice(index, 1)[0];
    active++;
    if (!job.foreground) prefetchActive++;
    job.run();
  }
}
export function cachedArtwork(url: string): string | undefined {
  return url.startsWith("https://") ? memory.get(url) : url;
}
export function loadArtwork(url: string, foreground = true): Promise<string> {
  const hit = cachedArtwork(url);
  if (hit) return Promise.resolve(hit);
  const running = pending.get(url);
  if (running) {
    if (foreground) {
      const job = queue.find((j) => j.url === url);
      if (job) job.foreground = true;
      pump();
    }
    return running;
  }
  const gen = generation;
  const request = new Promise<string>((resolve, reject) => {
    const job: Job = {
      url,
      foreground,
      run: () => {
        // A queued prefetch can be promoted before it starts.
        const isPrefetch = !job.foreground;
        void invoke<string>("get_cached_art", { url })
          .then((src) => {
            if (gen === generation) {
              const old = memory.get(url);
              if (old) bytes -= old.length * 2;
              memory.delete(url);
              memory.set(url, src);
              bytes += src.length * 2;
              while (bytes > LIMIT && memory.size > 1) {
                const first = memory.keys().next().value!;
                bytes -= memory.get(first)!.length * 2;
                memory.delete(first);
              }
            }
            resolve(src);
          })
          .catch(reject)
          .finally(() => {
            pending.delete(url);
            active--;
            if (isPrefetch) prefetchActive--;
            pump();
          });
      },
    };
    queue.push(job);
    pump();
  });
  pending.set(url, request);
  return request;
}
export function prefetchArtwork(urls: string[]) {
  for (const url of new Set(urls)) {
    if (queue.filter((j) => !j.foreground).length >= 8) break;
    void loadArtwork(url, false).catch(() => {});
  }
}
export async function clearArtwork() {
  generation++;
  memory.clear();
  bytes = 0;
  await invoke("clear_art_cache");
}
