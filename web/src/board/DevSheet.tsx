// /dev/sheet: the board in a minimal passthrough scene (dev builds only), for emulator runs
// before the XR room is integrated. Scripts drive it through window.__boardxr.
import { useEffect, useRef, useState } from 'preact/hooks';

export function DevSheet() {
  const stage = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState('Starting the scene.');

  useEffect(() => {
    let live = true;
    let destroy: (() => void) | null = null;
    import('./sheetScene')
      .then((m) => m.createDevSheet(stage.current as HTMLElement))
      .then((h) => {
        if (!live) return h.destroy();
        destroy = h.destroy;
        window.__boardxr = h;
        setNote('Enter the session to draw on the sheet.');
      })
      .catch(() => live && setNote('The scene could not start in this browser.'));
    return () => {
      live = false;
      destroy?.();
      delete window.__boardxr;
    };
  }, []);

  return (
    <div data-test="page-dev-sheet" style={{ position: 'fixed', inset: '0', zIndex: 20, background: '#000' }}>
      <div ref={stage} style={{ position: 'absolute', inset: '0' }} />
      <p style={{ position: 'absolute', left: '16px', bottom: '8px', color: '#fff', margin: 0 }}>{note}</p>
    </div>
  );
}

export default DevSheet;
