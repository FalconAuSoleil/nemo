import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { HostPage } from './pages/Host';
import { Landing } from './pages/Landing';
import { Stage } from './pages/Stage';
import { useRoom } from './net/room';
import { NemoFace } from './ui/panels';
import { storedLang, tr } from './i18n';

function Viewer({ code }: { code: string }) {
  const [state] = useRoom({ t: 'join', code });
  if (!state.view)
    return (
      <div className="h-dvh grid place-items-center bg-cream text-center p-6">
        <div>
          <div className="mx-auto w-fit">
            <NemoFace mode={state.status === 'error' ? 'idle' : 'thinking'} size={72} />
          </div>
          <p className="mt-3 font-display font-bold">{state.status === 'error' ? state.error : `${tr(storedLang(), 'joining')} ${code}…`}</p>
          {state.status === 'error' && (
            <a className="btn mt-4" href="/join">
              {tr(storedLang(), 'tryAnother')}
            </a>
          )}
        </div>
      </div>
    );
  return <Stage view={state.view} role="viewer" />;
}

function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  const go = (p: string) => {
    history.pushState(null, '', p);
    setPath(p);
  };
  const room = /^\/room\/([A-Za-z]{4})$/.exec(path);
  if (room) return <Viewer code={room[1].toUpperCase()} />;
  if (path === '/host') return <HostPage />;
  return <Landing go={go} joinOnly={path === '/join'} />;
}

// No StrictMode: double-mounted effects would open two host sessions.
createRoot(document.getElementById('root')!).render(<App />);
