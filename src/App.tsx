import { useEffect, useState } from 'react';
import { Landing } from './app/Landing';
import { Studio, type IncomingPhoto } from './app/Studio';
import { loadPhoto } from './ingest/loadPhoto';
import { LabsApp } from './labs/LabsApp';

type Route = 'landing' | 'studio' | 'labs';

/** Hash routes: #/studio, #/labs; anything else (including in-page anchors like #how) is the landing page. */
function routeFromHash(): Route {
  const h = location.hash;
  if (h.startsWith('#/studio')) return 'studio';
  if (h.startsWith('#/labs')) return 'labs';
  return 'landing';
}

export function App() {
  const [route, setRoute] = useState<Route>(() => {
    // The dev ?photo= loader lives in the studio, so open straight into it.
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('photo') && routeFromHash() === 'landing') return 'studio';
    return routeFromHash();
  });
  const [incoming, setIncoming] = useState<IncomingPhoto>(null);
  // Once opened, the studio stays mounted so visiting the landing page doesn't lose your work.
  const [studioOpened, setStudioOpened] = useState(route === 'studio');
  useEffect(() => { if (route === 'studio') setStudioOpened(true); }, [route]);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const goStudio = () => { location.hash = '#/studio'; setRoute('studio'); window.scrollTo(0, 0); };

  if (route === 'labs') return <LabsApp />;
  return (
    <>
      {route === 'landing' && (
        <Landing
          onPhoto={async (file) => {
            const { bitmap } = await loadPhoto(file);
            setIncoming({ bitmap, name: file.name });
            goStudio();
          }}
          onSample={() => { setIncoming('sample'); goStudio(); }}
        />
      )}
      {(studioOpened || route === 'studio') && (
        <div hidden={route !== 'studio'}>
          <Studio incoming={incoming} onConsumed={() => setIncoming(null)} />
        </div>
      )}
    </>
  );
}
