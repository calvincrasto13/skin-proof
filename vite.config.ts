import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Cross-origin isolation enables SharedArrayBuffer, which ONNX Runtime's multithreaded WASM
// backend needs. Without it the WASM fallback runs single-threaded. Production sets the same
// headers in public/_headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * ONNX Runtime's bundle names its 26 MB .wasm with `new URL(..., import.meta.url)`, so Vite copies
 * it into the build. It is never fetched: Transformers.js points ONNX Runtime at the same version
 * on jsDelivr at runtime. Dropping it keeps every file under Cloudflare Pages' 25 MiB limit.
 */
function dropOrtWasm(): Plugin {
  return {
    name: 'drop-ort-wasm',
    apply: 'build',
    generateBundle(_, bundle) {
      for (const name of Object.keys(bundle)) if (/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
    },
  };
}

export default defineConfig({
  plugins: [react(), dropOrtWasm()],
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es', plugins: () => [dropOrtWasm()] },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
