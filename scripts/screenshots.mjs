// Regenerates the README screenshots in docs/screens/ by driving the real app in headless Chrome
// with the stock photos and line-art designs in docs/stock/. Usage: npm run screenshots
//
// It uses the dev-only window.__tryon hook (see src/studio/useTryOn.ts) to place tattoos
// precisely, so it runs against the Vite dev server, which it starts itself.
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const OUT = 'docs/screens';
const PORT = 5174;
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error('No Chrome/Edge found; set CHROME_PATH');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });
const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const base = `http://localhost:${PORT}`;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--hide-scrollbars'],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  // ---------- 1. landing ----------
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await sleep(500);
  await page.screenshot({ path: `${OUT}/landing.png` });
  console.log('landing.png');

  // ---------- helpers that run in the page ----------
  const helpers = () => {
    const w = window;
    w.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    w.__waitDepth = async () => {
      for (let i = 0; i < 600; i++) {
        const s = w.__tryon?.depthState?.stage;
        if (s === 'done' || s === 'error') return s;
        await w.__sleep(250);
      }
      return 'timeout';
    };
    /** Rasterize an SVG design to a PNG File, as if the user picked it. */
    w.__svgFile = async (url, name) => {
      const svg = await (await fetch(url)).text();
      const img = new Image();
      img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth * 2;
      c.height = img.naturalHeight * 2;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return new File([blob], name, { type: 'image/png' });
    };
    w.__addDesigns = async (list) => {
      const dt = new DataTransfer();
      for (const [url, name] of list) dt.items.add(await w.__svgFile(url, name));
      const before = w.__tryon.layers.length;
      const input = document.querySelector('.st-left input[type=file]');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 40 && w.__tryon.layers.length < before + list.length; i++) await w.__sleep(100);
      return w.__tryon.layers.map((l) => l.id);
    };
    /** The body's extent along a vertical line x (fraction of width): centre and thickness, image px. */
    w.__bodyAcross = (fx) => {
      const s = w.__tryon.baseSurface;
      const x = fx * s.width;
      let best = null, run = null;
      for (let y = 0; y <= s.height; y += 2) {
        const inside = y < s.height && s.inside(x, y);
        if (inside && !run) run = { y0: y };
        if (!inside && run) {
          const len = y - run.y0;
          if (!best || len > best.len) best = { y0: run.y0, len };
          run = null;
        }
      }
      return best ? { x, y: best.y0 + best.len / 2, thick: best.len } : null;
    };
    w.__idle = async () => { await w.__sleep(350); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); };
  };

  const openStudio = async (photo) => {
    await page.goto(`${base}/?photo=${photo}&nosample#/studio`, { waitUntil: 'networkidle0' });
    await page.evaluate(helpers);
    await page.waitForFunction(() => window.__tryon?.depthState, { timeout: 30000 });
    const stage = await page.evaluate(() => window.__waitDepth());
    console.log(`  depth: ${stage}`);
    if (stage !== 'done') throw new Error(`depth estimation ${stage}`);
  };

  const stage = async () => page.$('.st-canvas');

  // ---------- 2. forearm in the studio: two tattoos, one selected ----------
  await openStudio('/docs/stock/forearm-white-wall.jpg');
  const forearm = await page.evaluate(async () => {
    const w = window;
    const [sprig, banner] = await w.__addDesigns([
      ['/docs/stock/designs/sprig.svg', 'botanical sprig'],
      ['/docs/stock/designs/banner.svg', 'fortune banner'],
    ]);
    const a = w.__bodyAcross(0.6), b = w.__bodyAcross(0.36);
    // The forearm runs left-right, so the sprig is turned to lie along it and wraps over the top.
    w.__tryon.updateLayer(sprig, { anchor: { x: a.x, y: a.y }, width: Math.round(a.thick * 1.15), rotation: -90 });
    w.__tryon.updateLayer(banner, { anchor: { x: b.x, y: b.y }, width: Math.round(b.thick * 2.6), rotation: 0, ink: { color: '#19273c', saturation: 1, opacity: 0.85 } });
    // Zoom onto the forearm (the view centres on the selected sprig; the banner sits in frame).
    w.__tryon.setSelectedId(sprig);
    w.__tryon.setZoom(2.0);
    await w.__idle();
    return { sprig, banner, a, b };
  });
  await page.screenshot({ path: `${OUT}/studio.png` });
  console.log('studio.png', forearm.a);

  // Mesh editing: one handle pulled, lattice shown.
  await page.evaluate(async ({ sprig }) => {
    const w = window;
    const d = new Float32Array(5 * 5 * 2);
    d[2 * (1 * 5 + 3)] = 0.06; // control (3,1): nudge along the design's own u axis
    d[2 * (1 * 5 + 3) + 1] = -0.05;
    w.__tryon.updateLayer(sprig, { lattice: { m: 5, d } });
    w.__tryon.setEditMesh(true);
    w.__tryon.setZoom(2.2);
    await w.__idle();
  }, forearm);
  await (await stage()).screenshot({ path: `${OUT}/mesh.png` });
  console.log('mesh.png');

  // ---------- 3. shoulder: before / after, sticker vs ink ----------
  await openStudio('/docs/stock/shoulder-tank-top.jpg');
  const shoulder = await page.evaluate(async () => {
    const w = window;
    const [sun] = await w.__addDesigns([['/docs/stock/designs/sun-moon.svg', 'sun and moon']]);
    const s = w.__tryon.baseSurface;
    // Aim for the rounded cap of the shoulder, where the light falls off into shadow.
    const p = s.nearestInside(0.4 * s.width, 0.42 * s.height, 40) ?? { x: 0.4 * s.width, y: 0.42 * s.height };
    w.__tryon.updateLayer(sun, { anchor: p, width: Math.round(0.24 * s.width) });
    w.__tryon.setSelectedId(sun);
    w.__tryon.setZoom(1.6);
    await w.__idle();
    w.__tryon.setSelectedId(null);
    await w.__idle();
    return { sun, p };
  });
  const shot = async (name) => { await page.evaluate(() => window.__idle()); await (await stage()).screenshot({ path: `${OUT}/${name}` }); console.log(name); };

  await shot('shoulder-after.png');
  await page.evaluate(() => window.__tryon.setComparing(true));
  await shot('shoulder-before.png');
  await page.evaluate(() => window.__tryon.setComparing(false));

  // The usual way: a flat sticker pasted on top.
  await page.evaluate(async ({ sun }) => {
    window.__tryon.updateLayer(sun, { warp: false });
    const sel = [...document.querySelectorAll('.st-right select')].find((s) => [...s.options].some((o) => o.value === 'sticker'));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'sticker');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, shoulder);
  await shot('shoulder-sticker.png');
  await page.evaluate(async ({ sun }) => {
    window.__tryon.updateLayer(sun, { warp: true });
    const sel = [...document.querySelectorAll('.st-right select')].find((s) => [...s.options].some((o) => o.value === 'sticker'));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'physical');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, shoulder);

  // ---------- 4. phone ----------
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await openStudio('/docs/stock/forearm-white-wall.jpg');
  await page.evaluate(async () => {
    const w = window;
    const [banner] = await w.__addDesigns([['/docs/stock/designs/banner.svg', 'fortune banner']]);
    const b = w.__bodyAcross(0.5);
    w.__tryon.updateLayer(banner, { anchor: { x: b.x, y: b.y }, width: Math.round(b.thick * 2.6) });
    w.__tryon.setSelectedId(banner);
    w.__tryon.setZoom(1.8);
    [...document.querySelectorAll('.st-tabs button')].find((x) => x.textContent.includes('Ink')).click();
    await w.__idle();
  });
  await page.screenshot({ path: `${OUT}/phone.png` });
  console.log('phone.png');
} finally {
  await browser.close();
  await server.close();
}
