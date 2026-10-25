import { useEffect, useState } from 'react';

type Mode = 'light' | 'dark';

const KEY = 'gd-theme';
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

/** The mode on screen: the commander's pick if they made one, otherwise the computer's setting. */
function currentMode(): Mode {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return systemDark() ? 'dark' : 'light';
}

/**
 * Light or dark. Until someone picks, the page follows the computer's setting
 * (the stylesheet's prefers-color-scheme rule); a pick is stored and set as
 * `data-theme` on <html>, which index.html also does before first paint so the
 * page never flashes the wrong mode. The button names the mode it switches to.
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>(currentMode);

  useEffect(() => {
    // Follow the computer's setting while nothing has been picked.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setMode(currentMode());
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const next: Mode = mode === 'dark' ? 'light' : 'dark';
  return (
    <button
      className="theme-toggle"
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem(KEY, next);
        } catch {
          // private window: the pick lasts until the page is closed
        }
        setMode(next);
      }}
      title={`Switch to ${next} mode`}
    >
      {next === 'dark' ? 'Dark' : 'Light'}
    </button>
  );
}
