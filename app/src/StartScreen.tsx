import { useEffect, useState, type CSSProperties } from 'react';
import { ThemeToggle } from './ThemeToggle.tsx';

interface Place {
  city?: string;
  state?: string;
  country?: string;
  where?: string;
}

interface MapRow extends Place {
  id: string;
  name: string;
  imported?: boolean;
  theme?: { team: string; primary: string; secondary: string };
}

interface Hit extends Place {
  name: string;
  osmType: 'way' | 'relation';
  osmId: number;
  lat: number;
  lon: number;
  capacity?: number;
  wikidata?: string;
}

/** One line from the import stream: a stage, a download byte count, the map, or an error. */
interface ImportEvent extends Place {
  stage?: string;
  label?: string;
  step?: number;
  steps?: number;
  bytes?: number;
  downloaded?: number;
  done?: boolean | { id?: string };
  id?: string;
  error?: string;
}

interface Progress {
  label: string;
  step: number;
  steps: number;
  bytes?: number;
}

const STAGE_LABELS: Record<string, string> = {
  search: 'Finding the stadium',
  lookup: 'Finding the stadium',
  download: 'Downloading map data',
  extract: 'Downloading map data',
  build: 'Building the map',
  gates: 'Placing gates',
  theme: 'Looking up team colours',
  save: 'Saving the map',
};

/** City, state, country when the server knows them; otherwise the old one-line place. */
function placeText(place: Place): string {
  const parts = [place.city, place.state, place.country].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(', ') : (place.where ?? '');
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * The empty start: pick a stadium you already have, or find any stadium on
 * OpenStreetMap and import it. Importing downloads the stadium and half a mile
 * around it, then builds the walkable map, streets, lots and gates.
 */
export function StartScreen({ onPick }: { onPick: (id: string) => void }) {
  const [maps, setMaps] = useState<MapRow[]>([]);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [failed, setFailed] = useState<Hit | null>(null);

  useEffect(() => {
    void fetch('/api/maps')
      .then((r) => r.json())
      .then(setMaps)
      .catch(() => setError('Could not reach the server. Start it with npm run serve.'));
  }, []);

  const search = async () => {
    setError(null);
    setFailed(null);
    setHits(null);
    setBusy('search');
    try {
      const res = await fetch(`/api/stadiums/search?q=${encodeURIComponent(q)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `search failed (${res.status})`);
      setHits(body as Hit[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const importHit = async (hit: Hit) => {
    const key = `${hit.osmType}-${hit.osmId}`;
    setError(null);
    setFailed(null);
    setProgress({ label: 'Starting import', step: 0, steps: 0 });
    setBusy(key);
    try {
      const res = await fetch('/api/stadiums/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify(hit),
      });

      // Older servers answer one JSON body, not a stream. Keep that path working.
      if (!(res.headers.get('content-type') ?? '').includes('ndjson')) {
        const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
        if (!res.ok) throw new Error(body.error ?? `import failed (${res.status})`);
        if (!body.id) throw new Error(body.error ?? 'import finished without a map');
        setBusy(null);
        setProgress(null);
        onPick(body.id);
        return;
      }

      if (!res.body) throw new Error('this browser cannot read the import stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let mapId: string | null = null;

      const handle = (line: string): string | null => {
        const event = JSON.parse(line) as ImportEvent;
        if (event.error) throw new Error(event.error);
        const bytes = event.bytes ?? event.downloaded;
        const step = Number(event.step);
        const steps = Number(event.steps);
        setProgress({
          label: event.label ?? (event.stage ? STAGE_LABELS[event.stage] ?? event.stage : 'Importing'),
          step: Number.isFinite(step) && step >= 0 ? step : 0,
          steps: Number.isFinite(steps) && steps > 0 ? steps : 0,
          bytes: typeof bytes === 'number' ? bytes : undefined,
        });
        const done = event.done && typeof event.done === 'object' ? event.done.id : undefined;
        return event.id ?? done ?? null;
      };

      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
          if (chunk.done) buffer += decoder.decode();
          let cut = buffer.indexOf('\n');
          while (cut >= 0) {
            const line = buffer.slice(0, cut).trim();
            buffer = buffer.slice(cut + 1);
            if (line) mapId = handle(line) ?? mapId;
            cut = buffer.indexOf('\n');
          }
          if (chunk.done) break;
        }
        if (buffer.trim()) mapId = handle(buffer.trim()) ?? mapId;
      } catch (e) {
        await reader.cancel().catch(() => undefined);
        throw e;
      }
      if (!mapId) throw new Error('import finished without a map');

      setBusy(null);
      setProgress(null);
      onPick(mapId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress(null);
      setFailed(hit);
      setBusy(null);
    }
  };

  const percent = progress && progress.steps > 0 ? Math.min(100, Math.round((progress.step / progress.steps) * 100)) : null;
  const downloading = progress !== null && progress.bytes !== undefined;

  return (
    <div className="start">
      <div className="start-card">
        <div className="start-head">
          <h1>Gameday Command</h1>
          <ThemeToggle />
        </div>
        <p className="lead">Test crowd and traffic plans for a stadium before game day. Pick one you have, or bring in any stadium from OpenStreetMap.</p>

        <h2>Your stadiums</h2>
        <div className="start-maps">
          {maps.map((m) => (
            <button key={m.id} className="start-map" onClick={() => onPick(m.id)} style={m.theme ? ({ '--edge': m.theme.primary } as CSSProperties) : undefined}>
              <strong>{m.name.replace(/ \+ 0\.5 mi$/, '')}</strong>
              {m.imported ? (
                <em>{[placeText(m), 'imported from OpenStreetMap'].filter(Boolean).join(' · ')}</em>
              ) : (
                <em>{m.id === 'test-3gate' ? 'small practice map' : 'ready to run'}</em>
              )}
              {m.theme && (
                <span className="swatch-pair" title={m.theme.team}>
                  <i style={{ background: m.theme.primary }} />
                  <i style={{ background: m.theme.secondary }} />
                  <em>{m.theme.team}</em>
                </span>
              )}
            </button>
          ))}
        </div>

        <h2>Import any stadium</h2>
        <form
          className="start-search"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Michigan Stadium, Beaver Stadium, Wembley" />
          <button className="go" disabled={q.trim().length < 3 || busy !== null}>
            {busy === 'search' ? 'Searching…' : 'Search'}
          </button>
        </form>
        {hits && hits.length === 0 && <p className="muted">No stadiums by that name on OpenStreetMap. Try the full name.</p>}
        {hits && hits.length > 0 && (
          <ul className="start-hits">
            {hits.map((h) => (
              <li key={`${h.osmType}-${h.osmId}`}>
                <span>
                  <strong>{h.name}</strong>
                  <em>{[placeText(h), h.capacity ? `${h.capacity.toLocaleString()} seats` : ''].filter(Boolean).join(', ')}</em>
                </span>
                <button className="small" disabled={busy !== null} onClick={() => void importHit(h)}>
                  {busy === `${h.osmType}-${h.osmId}` ? 'Importing…' : 'Import'}
                </button>
              </li>
            ))}
          </ul>
        )}
        {progress && (
          <div className="start-progress">
            <div className="start-progress-head" role="status" aria-live="polite">
              <span>{progress.label}</span>
              <span>
                {downloading
                  ? `${megabytes(progress.bytes ?? 0)} downloaded`
                  : percent !== null
                    ? `${progress.step} of ${progress.steps} steps`
                    : ''}
              </span>
            </div>
            <div
              className={`start-progress-track${percent === null ? ' waiting' : ''}`}
              role="progressbar"
              aria-label={progress.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
              aria-valuetext={downloading ? `${megabytes(progress.bytes ?? 0)} downloaded` : percent !== null ? `${percent}%` : 'working'}
            >
              <i style={percent !== null ? { width: `${percent}%` } : undefined} />
            </div>
          </div>
        )}
        {failed && (
          <div className="start-retry">
            <p className="error">{error}</p>
            <button className="small" disabled={busy !== null} onClick={() => void importHit(failed)}>
              Retry
            </button>
          </div>
        )}
        {!failed && error && <p className="error">{error}</p>}
        <p className="muted small-print">
          Map data © OpenStreetMap contributors (ODbL). Gates are placed evenly around the bowl and capacity comes from OSM where it is
          tagged: assumptions, shown as such.
        </p>
      </div>
    </div>
  );
}
