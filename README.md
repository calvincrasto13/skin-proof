# tattoo-viz labs

Three tabs. **Depth (2):** run Depth Anything V2 Small in a worker and inspect the surface it implies.
**Compositing (3):** the ink-on-skin blend, tested with flat shapes before any warping.
**Warp (4):** a design laid onto the depth surface by arc length and composited as a mesh.

```bash
npm install
npm run dev     # http://localhost:5173 (COOP/COEP headers on, for multithreaded WASM)
npm test        # arc-length layout vs. analytic cylinder
```

## What to look at

- **Two panes, same checkerboard.** Left: the surface derived from depth. Right: a cylinder fitted to two
  silhouette edges you draw. Drag on either pane to move the anchor. Where the two disagree, the depth
  model is the one that's wrong; that's the whole point of the comparison.
- **Overlays:** raw disparity (turbo), normals, n·v, and the mask. Check these when a warp looks off.
- **k (relief):** monocular depth has no scale. Auto-k is calibrated at the checkerboard anchor: it measures the
  half-width of the limb under it and makes the surface just inside that limb's edges as steep as a cylinder of
  that width. It follows the anchor, so in the full app k becomes per layer. If calibration reports failure
  (backs, torsos, cropped limbs), set k by hand.
- **Occlusion cuts:** where the disparity steps sharply *and* gentle body continues past the step (an arm in front
  of the torso), the surface is cut, so smoothing, calibration and the checkerboard never cross it. A limb's own
  steep rim against the background is not cut. Tune with the threshold slider; the "edge strength" overlay
  shows the threshold as the middle of the colormap and cuts in red.

## Spike-only shortcuts

- Geometry runs on a working copy capped at 2048 px; full resolution comes with export.
- Overlays and the checkerboard use Canvas 2D. The WebGL2 renderer starts with the compositing shader.
- The mask is an Otsu split of disparity. Fine on plain backgrounds, naive on busy ones.
- The model loads from the Hugging Face hub. The production build should self-host it behind `connect-src 'self'`.

## Compositing lab

Model, in `src/render/shaders.ts`:

- photo `C = D + S`: diffuse (subsurface, skin-coloured) plus specular (surface, roughly achromatic), split per
  pixel with the dichromatic reflection model against the local skin colour (a heavily blurred copy of the photo)
- ink sits under the epidermis, so it filters `D` and not `S`: `out = D·T + S`, in linear light. Shading transfer
  falls out of the multiply.
- `T = Tfull^density` (Beer–Lambert), so diluted ink lightens and shifts hue the way real grey wash does.
  `Tfull` is the pigment lifted by epidermal scatter, stronger at short wavelengths, which is why healed black
  reads blue-black.
- grain re-adds the photo's own measured noise where the multiply suppressed it
- edge blur defaults to the photo's own measured edge softness (`src/render/sharpness.ts`): the Gaussian σ of
  its strongest clean step edges, minus the ink's 1 px antialias. On a downscaled phone photo that's ~0.2 px;
  on a full-resolution one, more. A fixed default was measurably wrong: it made fine lines lighter than real ones.

Test shapes: a flat rectangle (the blend), a 0→1 density ramp (the opacity curve), and rings from hairline to bold
(edge softness). The **Blend** select has the two usual wrong answers (multiply in sRGB, normal-alpha "sticker")
for A/B comparison, and **View** shows `D`, `S`, `T` and density separately. Hold the button or Space to flash
the original.

With a depth result the skin-colour base is blurred within the body mask only (normalized convolution), so
the background no longer leaks into it at the silhouette, and ink is clipped to the body.

## Warp lab

- The design (sample line art, a checker, rings, or your own line art through a basic luminance key) is laid out
  on a 33×33 mesh by `layoutByArcLength` on the depth surface, with k calibrated under the anchor. The mesh is
  drawn into the ink-density buffer (MAX blend, since the mesh can fold near the horizon) and composited as before.
- **Warp off** lays the same mesh on a flat surface: the sticker-geometry baseline for A/B tests.
- **Surface smoothing** defaults to σ 4 depth px. At σ 2 the depth model's response to existing tattoos showed
  up as wobble in the mesh rows.
- **Rim prior:** depth is mushiest at the silhouette, and smoothing flattens it further, so layouts used to hit
  the mask edge at ~70° and stop there with a sticker-like cut. Within 35% of the limb half-width from an edge,
  the slope is never flatter than a cylinder of that half-width. It applies only on the near side of an edge,
  so the torso behind an occluding arm is untouched.
- **Show mesh** draws every 4th grid line over the composite.

`?photo=/dev/<file>` loads a photo from the gitignored `public/dev` folder (dev server only), for driving tests
without the file picker.
