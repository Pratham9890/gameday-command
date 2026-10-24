import { useEffect, useState } from 'react';

interface MapRow {
  id: string;
  name: string;
  imported?: boolean;
}

interface Hit {
  name: string;
  where: string;
  osmType: 'way' | 'relation';
  osmId: number;
  lat: number;
  lon: number;
  capacity?: number;
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

  useEffect(() => {
    void fetch('/api/maps')
      .then((r) => r.json())
      .then(setMaps)
      .catch(() => setError('Could not reach the server. Start it with npm run serve.'));
  }, []);

  const search = async () => {
    setError(null);
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
    setError(null);
    setBusy(`${hit.osmType}-${hit.osmId}`);
    try {
      const res = await fetch('/api/stadiums/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hit) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `import failed (${res.status})`);
      onPick(body.id as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  return (
    <div className="start">
      <div className="start-card">
        <h1>Gameday Command</h1>
        <p className="lead">Choose a stadium to plan for.</p>

        <h2>Your stadiums</h2>
        <div className="start-maps">
          {maps.map((m) => (
            <button key={m.id} className="start-map" onClick={() => onPick(m.id)}>
              <strong>{m.name.replace(/ \+ 0\.5 mi$/, '')}</strong>
              <em>{m.imported ? 'imported from OpenStreetMap' : m.id === 'test-3gate' ? 'small practice map' : 'ready to run'}</em>
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
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Michigan Stadium, Beaver Stadium, Wembley" />
          <button className="primary" disabled={q.trim().length < 3 || busy !== null}>
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
                  <em>
                    {h.where}
                    {h.capacity ? ` · ${h.capacity.toLocaleString()} seats` : ''}
                  </em>
                </span>
                <button className="small" disabled={busy !== null} onClick={() => void importHit(h)}>
                  {busy === `${h.osmType}-${h.osmId}` ? 'Importing… (about a minute)' : 'Import'}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="error">{error}</p>}
        <p className="muted small-print">
          Map data © OpenStreetMap contributors (ODbL). Gates are placed evenly around the bowl and capacity comes from OSM where it is
          tagged: assumptions, shown as such.
        </p>
      </div>
    </div>
  );
}
