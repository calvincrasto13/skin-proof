import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Cross-origin isolation enables SharedArrayBuffer, which ONNX Runtime's
// multithreaded WASM backend needs. Without it the WASM fallback runs single-threaded.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
