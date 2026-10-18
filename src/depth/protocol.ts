export type DevicePref = 'auto' | 'webgpu' | 'wasm';

export type WorkerRequest = {
  type: 'run';
  /** Already downscaled on the main thread; the model resizes to ~518px anyway. */
  image: ImageBitmap;
  device: DevicePref;
};

export type Stage = 'detecting-backend' | 'downloading' | 'compiling' | 'inferring';

export type WorkerResponse =
  | { type: 'stage'; stage: Stage; detail?: string }
  | { type: 'download'; loaded: number; total: number }
  | {
      type: 'result';
      /** Relative inverse depth (disparity), larger = closer. Affine-invariant: scale and shift unknown. */
      disparity: Float32Array;
      width: number;
      height: number;
      device: 'webgpu' | 'wasm';
      dtype: string;
      /** ms; loadMs is 0 when the model was already resident (warm run). */
      loadMs: number;
      inferMs: number;
      warm: boolean;
    }
  | { type: 'error'; message: string };
