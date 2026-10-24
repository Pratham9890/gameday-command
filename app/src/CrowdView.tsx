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
  selected: number | null;
  onPick: (dot: number | null) => void;
  /** Bumped by the parent to centre on the selected group. */
  focusToken: number;
}

/**
 * One run, close up. Owns its own PixiJS Application, so the app mounts either
 * this or the side-by-side maps, never both: one WebGL context at a time.
 */
export function CrowdView({ map, run, types, scrubIndex, dangerDensity, incidentCells, selected, onPick, focusToken }: CrowdViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CrowdScene | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
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
    scene.setFrame(
      { t: frame.t, x: frame.x, y: frame.y, state: frame.state, officerCells: frame.officerCells, density: density?.peoplePerM2 },
      scrubIndex === null,
    );
  }, [run, run.tick, scrubIndex, map, types, dangerDensity]);

  useEffect(() => {
    sceneRef.current?.setZone(incidentCells);
  }, [incidentCells, map, types, dangerDensity]);

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

  return (
    <div className="crowd">
      <div className="crowd-host" ref={hostRef} />
      <div className="crowd-overlay" ref={overlayRef} />
      <div className="crowd-tools">
        <button title="Zoom in" onClick={() => sceneRef.current?.zoomBy(1.6)}>+</button>
        <button title="Zoom out" onClick={() => sceneRef.current?.zoomBy(1 / 1.6)}>−</button>
        <button title="Whole map" onClick={() => sceneRef.current?.fit()}>⤢</button>
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
      <div className="crowd-hint">scroll to zoom · drag to pan · click a person</div>
    </div>
  );
}
