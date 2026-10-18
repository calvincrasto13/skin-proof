import { useState } from 'react';
import { CompositeLab } from '../ui/CompositeLab';
import { DepthLab } from '../ui/DepthLab';
import { WarpLab } from '../ui/WarpLab';
import './labs.css';

type Tab = 'depth' | 'composite' | 'warp';

/** The engineering labs (deliverables 2–4), kept for debugging at #/labs. */
export function LabsApp() {
  const [tab, setTab] = useState<Tab>('warp');
  return (
    <div className="labs"><div className="app">
      <header className="top">
        <div>
          <h1>Skin Proof labs</h1>
          <p className="muted">Photo stays on this device. Only the depth model's weights are downloaded.</p>
        </div>
        <nav className="row">
          <a href="#/" style={{ color: 'var(--muted)', alignSelf: 'center', marginRight: 8 }}>← App</a>
          <button className={tab === 'depth' ? 'active' : ''} onClick={() => setTab('depth')}>Depth (2)</button>
          <button className={tab === 'composite' ? 'active' : ''} onClick={() => setTab('composite')}>Compositing (3)</button>
          <button className={tab === 'warp' ? 'active' : ''} onClick={() => setTab('warp')}>Warp (4)</button>
        </nav>
      </header>
      {/* Both stay mounted so switching tabs keeps the loaded model and photos. */}
      <div hidden={tab !== 'depth'}><DepthLab /></div>
      <div hidden={tab !== 'composite'}><CompositeLab /></div>
      <div hidden={tab !== 'warp'}><WarpLab /></div>
    </div></div>
  );
}
