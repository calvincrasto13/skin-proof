import type { DevicePref, WorkerResponse } from './protocol';

export type DepthResult = Extract<WorkerResponse, { type: 'result' }>;
export type DepthEvent = Exclude<WorkerResponse, { type: 'result' } | { type: 'error' }>;

/**
 * Owns the depth worker. The model stays resident between runs so warm timings can be
 * measured; call dispose() to terminate the worker, which is the only way to hand the
 * WASM heap back to the OS (it never shrinks).
 */
export class DepthClient {
  private worker: Worker | null = null;
  private busy = false;

  async run(photo: ImageBitmap, device: DevicePref, onEvent: (e: DepthEvent) => void): Promise<DepthResult> {
    if (this.busy) throw new Error('Depth estimation already running');
    this.busy = true;
    this.worker ??= new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const worker = this.worker;

    // Send a bounded copy; the original stays on the main thread for display.
    const scale = Math.min(1, 1024 / Math.max(photo.width, photo.height));
    const image = await createImageBitmap(photo, {
      resizeWidth: Math.round(photo.width * scale),
      resizeHeight: Math.round(photo.height * scale),
      resizeQuality: 'high',
    });

    try {
      return await new Promise<DepthResult>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
          const msg = e.data;
          if (msg.type === 'result') resolve(msg);
          else if (msg.type === 'error') reject(new Error(msg.message));
          else onEvent(msg);
        };
        worker.onerror = (e) => reject(new Error(e.message || 'Depth worker crashed'));
        worker.postMessage({ type: 'run', image, device }, [image]);
      });
    } finally {
      this.busy = false;
    }
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
  }
}
