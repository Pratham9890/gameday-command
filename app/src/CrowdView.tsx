import { useEffect, useRef, useState } from 'react';
import type { FanType, MapBundle } from '../../contracts.ts';
import { CrowdScene } from './crowd-scene.ts';
import { groupName } from './people.ts';
import type { RunHandle } from './useRun.ts';

export interface CrowdViewProps {
  map: MapBundle;
  run: RunHandle;
  types: FanType[];
  scrubIndex: number | null;
  dangerDensity: number;
  incidentCells?: number[];
  /** Shown over the incident zone, e.g. "Gate surge". */
  incidentLabel?: string;
  selected: number | null;
  onPick: (dot: number | null) => void;
  selectedOfficer: string | null;
  onPickOfficer: (id: string) => void;
  /** Bumped by the parent to centre on the selected group. */
  focusToken: number;
}

/**
 * One run, close up. Owns its own PixiJS Application, so the app mounts either
 * this or the side-by-side maps, never both: one WebGL context at a time.
 */
export function CrowdView({ map, run, types, scrubIndex, dangerDensity, incidentCells, incidentLabel, selected, onPick, selectedOfficer, onPickOfficer, focusToken }: CrowdViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CrowdScene | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const pickOfficerRef = useRef(onPickOfficer);
  pickOfficerRef.current = onPickOfficer;
  /** Alerts already flashed, so each one lights up once. */
  const alertsShown = useRef(0);
  const [following, setFollowing] = useState(false);
  const [heat, setHeat] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    const overlay = overlayRef.current;
    if (!host || !overlay) return;
    const scene = new CrowdScene({
      host,
      overlay,
      map,
      types,
      dangerDensity,
      onPick: (dot) => pickRef.current(dot),
      onPickOfficer: (id) => pickOfficerRef.current(id),
      onFollowChange: setFollowing,
    });
    sceneRef.current = scene;
    return () => {
      sceneRef.current = null;
      scene.destroy();
    };
  }, [map, types, dangerDensity]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const kept = run.frames.current ?? [];
    const view = scrubIndex === null ? run.latest.current : (kept[Math.min(scrubIndex, kept.length - 1)] ?? run.latest.current);
    scene.setTypes(run.typeIndex.current);
    if (!view) return;
    const { frame, density } = view;
    const live = scrubIndex === null;
    // Officer detail lives only on the latest frame; a replayed frame falls back to bare officer cells.
    scene.setScene(live ? run.scene.current : null, live);
    scene.setFrame(
      { t: frame.t, x: frame.x, y: frame.y, state: frame.state, officerCells: frame.officerCells, density: density?.peoplePerM2 },
      live,
    );
    const alerts = run.alerts.current ?? [];
    if (alerts.length < alertsShown.current) alertsShown.current = alerts.length; // rewound
    if (live && alerts.length > alertsShown.current) scene.flashAlert(alerts[alerts.length - 1]!.dots);
    alertsShown.current = alerts.length;
  }, [run, run.tick, scrubIndex, map, types, dangerDensity]);

  useEffect(() => {
    sceneRef.current?.setZone(incidentCells, incidentLabel);
  }, [incidentCells, incidentLabel, map, types, dangerDensity]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setSelected(selected);
    if (selected !== null) scene.setName(groupName(selected));
  }, [selected]);

  useEffect(() => {
    if (focusToken > 0 && selected !== null) sceneRef.current?.focus(selected);
    // Only a new token means "go there"; a new selection alone does not move the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);

  useEffect(() => {
    sceneRef.current?.setHeat(heat);
  }, [heat]);

  useEffect(() => {
    sceneRef.current?.setSelectedOfficer(selectedOfficer);
  }, [selectedOfficer]);

  return (
    <div className="crowd">
      <div className="crowd-host" ref={hostRef} />
      <div className="crowd-overlay" ref={overlayRef} />
      <div className="crowd-tools">
        <button title="Zoom in" onClick={() => sceneRef.current?.zoomBy(1.6)}>+</button>
        <button title="Zoom out" onClick={() => sceneRef.current?.zoomBy(1 / 1.6)}>−</button>
        <button title="Whole map" onClick={() => sceneRef.current?.fit()}>⤢</button>
        <button title="Back to the incident" onClick={() => sceneRef.current?.showIncident()}>⚠</button>
      </div>
      <div className="crowd-toggles">
        <label>
          <input type="checkbox" checked={heat} onChange={(e) => setHeat(e.target.checked)} /> density
        </label>
        {selected !== null && (
          <label>
            <input
              type="checkbox"
              checked={following}
              onChange={(e) => {
                if (e.target.checked) sceneRef.current?.focus(selected);
                else sceneRef.current?.setFollowing(false);
              }}
            />{' '}
            follow
          </label>
        )}
      </div>
      <div className="crowd-hint">scroll to zoom · drag to move · click a fan or an officer</div>
    </div>
  );
}
