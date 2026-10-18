/// <reference lib="webworker" />
import {
  AutoImageProcessor,
  AutoModelForDepthEstimation,
  RawImage,
  env,
  type PreTrainedModel,
  type Processor,
} from '@huggingface/transformers';
import type { WorkerRequest, WorkerResponse } from './protocol';

const MODEL_ID = 'onnx-community/depth-anything-v2-small';
// The image processor resizes to a 518px short edge; anything bigger is wasted transfer.
const MAX_INPUT_EDGE = 1024;

env.allowLocalModels = false;

type Loaded = {
  device: 'webgpu' | 'wasm';
  dtype: string;
  model: PreTrainedModel;
  processor: Processor;
};
let loaded: Loaded | null = null;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

async function pickBackend(pref: WorkerRequest['device']): Promise<{ device: 'webgpu' | 'wasm'; dtype: string }> {
  if (pref !== 'wasm' && 'gpu' in navigator) {
    const adapter = await (navigator as any).gpu.requestAdapter().catch(() => null);
    if (adapter) {
      // fp16 halves the download and is the fast path; without shader-f16 fall back to fp32 weights.
      return { device: 'webgpu', dtype: adapter.features.has('shader-f16') ? 'fp16' : 'fp32' };
    }
    if (pref === 'webgpu') throw new Error('WebGPU requested but no adapter is available');
  }
  // int8 is the right trade on CPU: ~27MB and faster than fp32 under WASM SIMD.
  return { device: 'wasm', dtype: 'q8' };
}

async function ensureModel(pref: WorkerRequest['device']): Promise<number> {
  post({ type: 'stage', stage: 'detecting-backend' });
  const { device, dtype } = await pickBackend(pref);
  if (loaded && loaded.device === device && loaded.dtype === dtype) return 0;
  if (loaded) await loaded.model.dispose();
  loaded = null;

  const t0 = performance.now();
  post({ type: 'stage', stage: 'downloading', detail: `${device} / ${dtype}` });
  const model = await AutoModelForDepthEstimation.from_pretrained(MODEL_ID, {
    device,
    dtype: dtype as any,
    progress_callback: (p: any) => {
      if (p.status === 'progress_total') post({ type: 'download', loaded: p.loaded, total: p.total });
    },
  });
  const processor = (await AutoImageProcessor.from_pretrained(MODEL_ID)) as unknown as Processor;
  loaded = { device, dtype, model, processor };
  return performance.now() - t0;
}

function bitmapToRgb(image: ImageBitmap): RawImage {
  const scale = Math.min(1, MAX_INPUT_EDGE / Math.max(image.width, image.height));
  const w = Math.round(image.width * scale);
  const h = Math.round(image.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0, w, h);
  image.close();
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const rgb = new Uint8ClampedArray(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return new RawImage(rgb, w, h, 3);
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.type !== 'run') return;
  try {
    const loadMs = await ensureModel(req.device);
    const { model, processor, device, dtype } = loaded!;
    const image = bitmapToRgb(req.image);
    const inputs = await (processor as any)(image);

    post({
      type: 'stage',
      stage: 'inferring',
      detail: loadMs > 0 && device === 'webgpu' ? 'first run includes WebGPU pipeline compile' : undefined,
    });
    const t0 = performance.now();
    const { predicted_depth } = await model(inputs);
    const inferMs = performance.now() - t0;

    // predicted_depth: [1, h, w] at the processor's resized resolution (not the input's).
    const t = predicted_depth.type === 'float32' ? predicted_depth : predicted_depth.to('float32');
    const [height, width] = t.dims.slice(-2) as [number, number];
    const disparity = new Float32Array(t.data as Float32Array);
    post(
      { type: 'result', disparity, width, height, device, dtype, loadMs, inferMs, warm: loadMs === 0 },
      [disparity.buffer],
    );
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
