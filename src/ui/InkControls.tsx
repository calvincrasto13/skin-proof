import type { ReactNode } from 'react';
import type { BlendMode, DebugView, InkParams, LayerInk } from '../render/compositor';

const PRESETS: Record<string, Partial<InkParams>> = {
  // Colours are the ink as pigment in the dermis, before epidermal scatter lifts them.
  black: { color: '#1d1e22', saturation: 1, opacity: 0.85 },
  'blue-black': { color: '#19273c', saturation: 1, opacity: 0.85 },
  'grey wash': { color: '#1d1e22', saturation: 1, opacity: 0.45 },
};

export const DEFAULT_INK: InkParams = {
  color: '#1d1e22',
  saturation: 1,
  opacity: 0.85,
  scatter: 0.12,
  blur: 0.8,
  grain: 1,
  specPass: 1,
  specFloor: 0.01,
};

type SetInk = (f: (s: InkParams) => InkParams) => void;

function inkSlider(ink: InkParams, setInk: SetInk, label: string, k: keyof InkParams, min: number, max: number, step: number, fmt = (v: number) => v.toFixed(2)) {
  return (
    <label>{label} {fmt(ink[k] as number)}
      <input type="range" min={min} max={max} step={step} value={ink[k] as number}
        onChange={(e) => setInk((s) => ({ ...s, [k]: +e.target.value }))} />
    </label>
  );
}

export function InkFieldset({ ink, setInk }: { ink: InkParams; setInk: SetInk }) {
  return (
    <fieldset>
      <legend>Ink</legend>
      <div className="row">
        {Object.entries(PRESETS).map(([name, p]) => (
          <button key={name} onClick={() => setInk((s) => ({ ...s, ...p }))}>{name}</button>
        ))}
        <input type="color" value={ink.color} onChange={(e) => setInk((s) => ({ ...s, color: e.target.value }))} title="Ink colour (pigment, before scatter)" />
      </div>
      {inkSlider(ink, setInk, 'Opacity (concentration)', 'opacity', 0, 1, 0.01)}
      {inkSlider(ink, setInk, 'Saturation', 'saturation', 0, 2, 0.01)}
      {inkSlider(ink, setInk, 'Epidermal scatter', 'scatter', 0, 0.6, 0.01)}
      {inkSlider(ink, setInk, 'Edge blur (px, auto from photo)', 'blur', 0, 6, 0.05)}
      {inkSlider(ink, setInk, 'Grain (× photo noise)', 'grain', 0, 3, 0.05)}
    </fieldset>
  );
}

export function ModelFieldset(p: {
  ink: InkParams; setInk: SetInk;
  mode: BlendMode; setMode: (m: BlendMode) => void;
  debug: DebugView; setDebug: (d: DebugView) => void;
  setComparing: (b: boolean) => void;
  onReset: () => void;
  children?: ReactNode;
}) {
  return (
    <fieldset>
      <legend>Model & ablations</legend>
      <label>Blend{' '}
        <select value={p.mode} onChange={(e) => p.setMode(e.target.value as BlendMode)}>
          <option value="physical">physical: linear, D·T + S</option>
          <option value="srgb-multiply">multiply in sRGB (common mistake)</option>
          <option value="sticker">normal alpha (sticker)</option>
        </select>
      </label>
      {inkSlider(p.ink, p.setInk, 'Specular passes over ink', 'specPass', 0, 1, 0.05)}
      {inkSlider(p.ink, p.setInk, 'Specular floor', 'specFloor', 0, 0.08, 0.002, (v) => v.toFixed(3))}
      <label>View{' '}
        <select value={p.debug} onChange={(e) => p.setDebug(e.target.value as DebugView)}>
          <option value="composite">composite</option>
          <option value="original">original photo</option>
          <option value="diffuse">diffuse D (what ink filters)</option>
          <option value="specular">specular S ×4 (what passes over ink)</option>
          <option value="transmittance">ink transmittance T</option>
          <option value="density">ink density</option>
        </select>
      </label>
      {p.children}
      <div className="row">
        <button
          onPointerDown={() => p.setComparing(true)}
          onPointerUp={() => p.setComparing(false)}
          onPointerLeave={() => p.setComparing(false)}
        >Hold to compare (or Space)</button>
        <button onClick={p.onReset}>Reset</button>
      </div>
    </fieldset>
  );
}

/** Ink that belongs to one tattoo layer: pigment colour, saturation, concentration. */
export function LayerInkControls({ ink, onChange }: { ink: LayerInk; onChange: (ink: LayerInk) => void }) {
  return (
    <>
      <div className="row">
        {Object.entries(PRESETS).map(([name, p]) => (
          <button key={name} onClick={() => onChange({ color: p.color!, saturation: p.saturation!, opacity: p.opacity! })}>{name}</button>
        ))}
        <input type="color" value={ink.color} onChange={(e) => onChange({ ...ink, color: e.target.value })} title="Ink colour (pigment, before scatter)" />
      </div>
      <label>Opacity (concentration) {ink.opacity.toFixed(2)}
        <input type="range" min={0} max={1} step={0.01} value={ink.opacity} onChange={(e) => onChange({ ...ink, opacity: +e.target.value })} />
      </label>
      <label>Saturation {ink.saturation.toFixed(2)}
        <input type="range" min={0} max={2} step={0.01} value={ink.saturation} onChange={(e) => onChange({ ...ink, saturation: +e.target.value })} />
      </label>
    </>
  );
}

/** Settings that belong to the skin and photo, shared by every layer. */
export function SkinFieldset({ ink, setInk }: { ink: InkParams; setInk: SetInk }) {
  return (
    <fieldset>
      <legend>Skin & photo (all layers)</legend>
      {inkSlider(ink, setInk, 'Epidermal scatter', 'scatter', 0, 0.6, 0.01)}
      {inkSlider(ink, setInk, 'Edge blur (px, auto from photo)', 'blur', 0, 6, 0.05)}
      {inkSlider(ink, setInk, 'Grain (× photo noise)', 'grain', 0, 3, 0.05)}
    </fieldset>
  );
}
