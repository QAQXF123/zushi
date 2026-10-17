export interface DownloadItem {
  url: string;
  championName: string;
  skinName: string;
}

export const downloadKey = (item: DownloadItem) =>
  JSON.stringify([item.championName, item.skinName]);

/** Keep up to ten transfers active, deduplicating both waiting and active items. */
export function createDownloadQueue(
  transfer: (item: DownloadItem) => Promise<unknown>,
  onChange: (active: DownloadItem | null, pending: string[], activeCount: number) => void,
  onError: (message: string) => void,
  onFinished: () => Promise<void>,
  concurrency = 10,
) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Download concurrency must be a positive integer");
  }
  const pending = new Set<string>();
  const queue: DownloadItem[] = [];
  const active = new Map<string, DownloadItem>();
  const idleWaiters: (() => void)[] = [];
  const notify = () => onChange(active.values().next().value ?? null, [...pending], active.size);

  async function run(item: DownloadItem) {
    const key = downloadKey(item);
    try {
      await transfer(item);
      await onFinished();
    } catch (error) {
      onError(`${item.championName} / ${item.skinName}: ${String(error)}`);
    } finally {
      pending.delete(key);
      active.delete(key);
      pump();
    }
  }

  function pump() {
    while (active.size < concurrency && queue.length > 0) {
      const item = queue.shift()!;
      active.set(downloadKey(item), item);
      void run(item);
    }
    notify();
    if (pending.size === 0) {
      for (const resolve of idleWaiters.splice(0)) resolve();
    }
  }

  return {
    enqueue(items: DownloadItem[]) {
      for (const item of items) {
        const key = downloadKey(item);
        if (pending.has(key)) continue;
        pending.add(key);
        queue.push(item);
      }
      // Register before starting: even a synchronously failed transfer can settle.
      const drained = new Promise<void>((resolve) => idleWaiters.push(resolve));
      pump();
      return drained;
    },
  };
}
