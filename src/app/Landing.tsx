import { useState } from 'react';
import { ILock, IUpload, Logo } from './icons';

type Props = {
  onPhoto: (file: File) => void;
  onSample: () => void;
};

/** The front door: what it does, how to get a good photo, and why the photo is safe. */
export function Landing({ onPhoto, onSample }: Props) {
  const [dragging, setDragging] = useState(false);
  const pickFile = (files: FileList | null) => {
    const f = files?.[0];
    if (f && f.type.startsWith('image/')) onPhoto(f);
  };

  return (
    <div className="landing">
      <header className="wrap l-nav">
        <a href="#top" className="wordmark"><Logo /><span>Skin Proof</span></a>
        <nav aria-label="Main">
          <a href="#how">How it works</a>
          <a href="#photo-tips">Photo tips</a>
          <a href="#privacy">Privacy</a>
          <a href="#/studio" className="pill pill-ink">Open the studio</a>
        </nav>
      </header>

      <main>
        <section id="top" className="wrap hero">
          <div
            className={`hero-copy${dragging ? ' drop-hint' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); pickFile(e.dataTransfer.files); }}
          >
            <p className="eyebrow">Before the needle</p>
            <h1 className="display">See it on your skin first.</h1>
            <p className="lede">Upload a photo of your arm and your design. Skin Proof maps the curve of your limb and shades the ink into your skin, so it reads like a healed tattoo, not a sticker.</p>
            <div className="actions">
              <label className="pill pill-red">
                <IUpload size={20} />
                Choose a body photo
                <input type="file" accept="image/*" className="sr-only" onChange={(e) => { pickFile(e.target.files); e.target.value = ''; }} />
              </label>
              <button type="button" className="pill pill-line" onClick={onSample}>Try a sample arm</button>
            </div>
            <p className="reassure"><ILock size={16} /> Your photo never leaves this device. No account needed.</p>
          </div>

          <figure>
            <div className="art">
              <HeroArt />
              <span className="tag" style={{ left: 16 }}>Before</span>
              <span className="tag" style={{ right: 16 }}>After</span>
            </div>
            <figcaption>The design follows the arm and darkens with its shadow.</figcaption>
          </figure>
        </section>

        <section id="how" className="band">
          <div className="wrap section">
            <h2 className="display">How it works</h2>
            <ol className="steps">
              <li>
                <span className="num">01</span>
                <h3>Photograph the spot</h3>
                <p>Arm, forearm or back, straight on. Skin Proof estimates the shape of your body from that one photo, on your own device, in a few seconds.</p>
              </li>
              <li>
                <span className="num">02</span>
                <h3>Drop in your designs</h3>
                <p>Line art on white paper works best: a scan, a photo of a sketch, or your artist's flash. The paper is removed automatically and grey shading is kept.</p>
              </li>
              <li>
                <span className="num">03</span>
                <h3>Place, wrap, compare</h3>
                <p>Drag, size and rotate. The design wraps around your arm by itself. Hold to flash the original photo, then save a picture to show your artist.</p>
              </li>
            </ol>
          </div>
        </section>

        <section id="photo-tips" className="wrap section split">
          <div>
            <h2 className="display">A photo that works</h2>
            <p style={{ margin: 0, color: 'var(--ink-2)' }}>The result is only as good as the photo. These four things matter most.</p>
          </div>
          <ul className="tips">
            <li><strong>Straight on</strong><span>Camera level with the spot, about an arm's length away.</span></li>
            <li><strong>Soft, even light</strong><span>Window light is ideal. Harsh shadows confuse the shape.</span></li>
            <li><strong>Whole width in frame</strong><span>Both edges of the limb visible, so the wrap knows where it ends.</span></li>
            <li><strong>Plain background</strong><span>A wall behind you helps tell body from room. Sleeves pushed out of the way.</span></li>
          </ul>
        </section>

        <section id="privacy" className="privacy">
          <div className="wrap section split">
            <div>
              <p className="eyebrow">Privacy</p>
              <h2 className="display">Nothing is uploaded. Ever.</h2>
              <p style={{ margin: 0, maxWidth: '30rem' }}>Body photos are personal. Every step — shape estimation, ink, export — runs inside your browser. There is no server to send them to.</p>
            </div>
            <dl>
              <div><dt>On your device</dt><dd>The shape model runs on your graphics chip. Only its files are downloaded, once.</dd></div>
              <div><dt>No account</dt><dd>No sign-up, no gallery, no history.</dd></div>
              <div><dt>Close the tab, it's gone</dt><dd>Save the picture if you want it. Nothing else is kept.</dd></div>
              <div><dt>Check it yourself</dt><dd>Open your browser's network panel while you work: no photo leaves.</dd></div>
            </dl>
          </div>
        </section>

        <section className="wrap section limits">
          <div>
            <h2 className="display">Honest about the limits</h2>
            <p>It's a preview from a single photo, not a scan. Designs that run right around a limb, existing tattoos under the new one, and very harsh light are where it's least accurate. Your artist still has the final say on size and placement.</p>
          </div>
          <label className="pill pill-red" style={{ minHeight: 56, fontSize: 18 }}>
            Start a try-on
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => { pickFile(e.target.files); e.target.value = ''; }} />
          </label>
        </section>
      </main>

      <footer className="l-foot">
        <div className="wrap">
          <span>Skin Proof · a preview, not a promise</span>
          <a href="#/labs">Engineering labs</a>
        </div>
      </footer>
    </div>
  );
}

/** Illustration only: a before/after split of an arm, ink following its curve. */
function HeroArt() {
  return (
    <svg viewBox="0 0 400 500" preserveAspectRatio="xMidYMid slice" role="img"
      aria-label="An upper arm split down the middle: plain skin on the left, the word Memento tattooed across it on the right, curving with the arm">
      <defs>
        <linearGradient id="hwall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#E7E1D6" /><stop offset="1" stopColor="#D3CBBD" /></linearGradient>
        <linearGradient id="hskin" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8F5E44" /><stop offset="0.16" stopColor="#C48E69" /><stop offset="0.42" stopColor="#D7A47E" /><stop offset="0.74" stopColor="#B17C5B" /><stop offset="1" stopColor="#5E3A29" />
        </linearGradient>
        <filter id="hsoft"><feGaussianBlur stdDeviation="7" /></filter>
        <filter id="hink"><feGaussianBlur stdDeviation="0.5" /></filter>
        <path id="harc" d="M112 244 Q 200 270 288 244" />
        <clipPath id="hafter"><rect x="200" y="0" width="200" height="500" /></clipPath>
      </defs>
      <rect width="400" height="500" fill="url(#hwall)" />
      <path d="M108 0 C 100 140 96 300 104 500 L 304 500 C 300 300 298 140 292 0 Z" fill="url(#hskin)" />
      <g clipPath="url(#hafter)" filter="url(#hink)" style={{ mixBlendMode: 'multiply' }} opacity="0.86">
        <text fontFamily="'Pinyon Script', cursive" fontSize="58" fill="#26252B"><textPath href="#harc" startOffset="50%" textAnchor="middle">Memento</textPath></text>
        <path d="M118 286 Q 200 308 282 284" stroke="#26252B" strokeWidth="3" fill="none" />
        <path d="M150 300 l8 14 M180 304 l8 14 M210 306 l8 14 M240 304 l8 14" stroke="#26252B" strokeWidth="2" fill="none" />
      </g>
      <path d="M160 0 C 154 160 152 330 160 500" stroke="#FFFFFF" strokeOpacity="0.22" strokeWidth="20" fill="none" filter="url(#hsoft)" />
      <line x1="200" y1="0" x2="200" y2="500" stroke="#F3EFE7" strokeWidth="3" />
      <circle cx="200" cy="250" r="18" fill="#F3EFE7" />
      <path d="M193 244 l-6 6 6 6 M207 244 l6 6 -6 6" stroke="#15130F" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
