import { useEffect, useRef, useState } from 'react';
import type { FanType, MapBundle, VehicleKind } from '../../contracts.ts';
import type { PoliceHotspot } from './congestion.ts';
import { CrowdScene } from './crowd-scene.ts';
import { groupName } from './people.ts';
import { readoutOf, ReadoutChips } from './Readouts.tsx';
import type { RunHandle } from './useRun.ts';
import { WeatherFx } from './WeatherFx.tsx';

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
  showVehicles: boolean;
  vehicleFocus: VehicleKind | null;
  selectedVehicle: number | null;
  onPickVehicle: (vehicle: number) => void;
  /** A density band isolated on the map, or null for all of them. */
  selectedBand: number | null;
  /** Cells to frame, from the hotspot list; a new nonce means go there. */
  focusBox: { x0: number; y0: number; x1: number; y1: number; nonce: number } | null;
  /** Colour the roads by how traffic is moving. */
  showFlow: boolean;
  onShowFlow: (on: boolean) => void;
  /** The most congested areas, pinned on the map. */
  hotspots: PoliceHotspot[];
}

/**
 * One run, close up. Owns its own PixiJS Application, so the app mounts either
 * this or the side-by-side maps, never both: one WebGL context at a time.
 */
export function CrowdView(props: CrowdViewProps) {
  const { map, run, types, scrubIndex, dangerDensity, incidentCells, incidentLabel, selected, onPick, selectedOfficer, onPickOfficer, focusToken } = props;
  const { showVehicles, vehicleFocus, selectedVehicle, onPickVehicle, selectedBand, focusBox, showFlow, onShowFlow, hotspots } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CrowdScene | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const pickOfficerRef = useRef(onPickOfficer);
  pickOfficerRef.current = onPickOfficer;
  /** Alerts already flashed, so each one lights up once. */
  const alertsShown = useRef(0);
  const pickVehicleRef = useRef(onPickVehicle);
  pickVehicleRef.current = onPickVehicle;
  // The weather layer is laid out in CSS pixels, so a flake is the same size
  // here as over the side-by-side maps.
  const [size, setSize] = useState({ w: 1000, h: 600 });
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => setSize({ w: Math.max(1, host.clientWidth), h: Math.max(1, host.clientHeight) }));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
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
      onPickVehicle: (vehicle) => pickVehicleRef.current(vehicle),
      onFollowChange: setFollowing,
    });
    sceneRef.current = scene;
    // For unattended checks, like window.gamedayMap for the side-by-side maps.
    (window as unknown as { gamedayScene?: CrowdScene }).gamedayScene = scene;
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
      {
        t: frame.t,
        x: frame.x,
        y: frame.y,
        state: frame.state,
        officerCells: frame.officerCells,
        density: density?.peoplePerM2,
        vehicles: frame.vehicles,
        weather: frame.weather,
      },
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

  useEffect(() => {
    sceneRef.current?.setVehicles(showVehicles, vehicleFocus, selectedVehicle);
  }, [showVehicles, vehicleFocus, selectedVehicle, map, types, dangerDensity]);

  useEffect(() => {
    sceneRef.current?.setBand(selectedBand);
  }, [selectedBand, map, types, dangerDensity]);

  useEffect(() => {
    sceneRef.current?.setFlow(showFlow);
  }, [showFlow, map, types, dangerDensity]);

  useEffect(() => {
    sceneRef.current?.setHotspots(hotspots);
  }, [hotspots, map, types, dangerDensity]);

  useEffect(() => {
    if (focusBox) sceneRef.current?.lookAtCells(focusBox.x0, focusBox.y0, focusBox.x1, focusBox.y1);
  }, [focusBox]);

  const kept = run.frames.current ?? [];
  const shown = scrubIndex === null ? run.latest.current : (kept[Math.min(scrubIndex, kept.length - 1)] ?? run.latest.current);
  const readout = readoutOf(shown?.frame);

  return (
    <div className="crowd">
      <div className="crowd-host" ref={hostRef} />
      <div className="crowd-overlay" ref={overlayRef} />
      <div className="crowd-weather">
        <WeatherFx weathers={[readout.weather]} panelW={size.w} panelH={size.h} gap={0} totalW={size.w} />
      </div>
      <div className="crowd-readouts">
        <ReadoutChips readout={readout} />
      </div>
      <div className="crowd-tools">
        <button title="Zoom in" onClick={() => sceneRef.current?.zoomBy(1.6)}>+</button>
        <button title="Zoom out" onClick={() => sceneRef.current?.zoomBy(1 / 1.6)}>−</button>
        <button title="Show the whole map" onClick={() => sceneRef.current?.fit()}>Whole map</button>
        <button title="Back to the incident" onClick={() => sceneRef.current?.showIncident()}>Incident</button>
      </div>
      <div className="crowd-toggles">
        <label>
          <input type="checkbox" checked={heat} onChange={(e) => setHeat(e.target.checked)} /> Crowd density
        </label>
        <label>
          <input type="checkbox" checked={showFlow} onChange={(e) => onShowFlow(e.target.checked)} /> Traffic flow
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
      <div className="crowd-hint">Scroll to zoom, drag to move, click a fan or an officer</div>
    </div>
  );
}
