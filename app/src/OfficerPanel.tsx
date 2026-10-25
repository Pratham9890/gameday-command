import type { MapBundle } from '../../contracts.ts';
import { CELL_SIZE_M } from '../../contracts.ts';
import { policeStations } from '../../world/src/officers.ts';
import { officerLine } from './live-steps.ts';
import type { RunHandle } from './useRun.ts';

export interface OfficerPanelProps {
  map: MapBundle;
  run: RunHandle;
  label: string;
  officerId: string;
  onClose: () => void;
  onSendTo?: () => void;
  onRecall?: () => void;
  disabled?: boolean;
}

/** The inspector for an officer: who they are, where they are going, and how much they have helped. */
export function OfficerPanel({ map, run, label, officerId, onClose, onSendTo, onRecall, disabled = false }: OfficerPanelProps) {
  const officer = run.scene.current?.officers.find((o) => o.id === officerId);
  const station = policeStations(map).find((s) => s.cell === officer?.homeCell);
  const fromHome = officer
    ? Math.round(
        Math.hypot(
          (officer.homeCell % map.width) * CELL_SIZE_M - officer.x,
          Math.floor(officer.homeCell / map.width) * CELL_SIZE_M - officer.y,
        ),
      )
    : 0;
  const share = officer && officer.told > 0 ? Math.round((officer.followed / officer.told) * 100) : null;

  return (
    <aside className="inspector officer-panel">
      <header>
        <span className="swatch officer">🚓</span>
        <div>
          <h3>{officer?.unit ?? officerId}</h3>
          <p className="muted">
            Police officer · {station?.name ?? 'gate post'} · Plan {label}
          </p>
        </div>
        <button className="small ghost" onClick={onClose} title="Close">
          ✕
        </button>
      </header>
      {officer ? (
        <>
          <section>
            <p className={`state ${officer.state}`}>
              <i className="dot" /> {officerLine(officer, map)}
            </p>
            <dl className="detail">
              <dt>from their post</dt>
              <dd>{fromHome} m</dd>
              <dt>fans spoken to</dt>
              <dd>{officer.told.toLocaleString()}</dd>
              <dt>did as told</dt>
              <dd>{share === null ? '—' : `${officer.followed.toLocaleString()} (${share}%)`}</dd>
            </dl>
            {(onSendTo || onRecall) && (
              <div className="police-actions">
                {onSendTo && <button className="small" disabled={disabled} onClick={onSendTo}>Send to…</button>}
                {onRecall && <button className="small ghost" disabled={disabled} onClick={onRecall}>Back to post</button>}
              </div>
            )}
          </section>
          <section>
            <h4>What they do</h4>
            <p className="muted">
              Officers walk to where the plan sends them along the streets. On scene they keep directing the people around them: at a
              jammed gate they send its queue to the next open gate, and each officer at a gate speeds up entry by 10%.
            </p>
          </section>
        </>
      ) : (
        <section>
          <p className="muted">Waiting for the next frame…</p>
        </section>
      )}
    </aside>
  );
}
