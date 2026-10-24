import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

/**
 * No <StrictMode> here, deliberately.
 *
 * StrictMode mounts every effect twice in development. PixiJS owns a WebGL
 * context imperatively, and tearing the throwaway first Application down while
 * the real second one is still initialising leaves the second init unresolved:
 * the page stops mid-setup and never draws, with no error. The production
 * build was always fine, which is what made it so easy to misread as the
 * browser's fault rather than ours.
 */
createRoot(document.getElementById('root')!).render(<App />);
