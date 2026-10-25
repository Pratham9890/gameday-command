import type { StadiumTheme } from '../../contracts.ts';

const lum = (hex: string) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};
/** Dark text on light colours, light text on dark ones. */
export const inkOn = (hex: string) => (lum(hex) > 0.6 ? '#0b0f14' : '#ffffff');

/**
 * Paint the app in the stadium's home-team colours: the accent (buttons, plan
 * letters, header rule) is whichever of the two colours is dark enough to carry
 * white text, so a white-shirted team still gets readable buttons.
 */
export function applyTheme(theme: StadiumTheme | undefined): void {
  const root = document.documentElement.style;
  const primary = theme?.primary ?? '#bb0000';
  const secondary = theme?.secondary ?? '#666666';
  const accent = lum(primary) <= 0.6 ? primary : lum(secondary) <= 0.6 ? secondary : '#30363d';
  root.setProperty('--scarlet', accent);
  root.setProperty('--team', primary);
  root.setProperty('--team2', secondary);
  root.setProperty('--team-ink', inkOn(primary));
  root.setProperty('--team2-ink', inkOn(secondary));
}
