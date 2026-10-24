import type { DecisionDefaults, Id, IncidentKind, MapBundle, ResponsePlan } from '../../contracts.ts';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return (await res.json()) as T;
}

export const getMap = (id: Id) => getJson<MapBundle>(`/api/maps/${id}`);
export const getDecisionDefaults = () => getJson<DecisionDefaults>('/api/decision-defaults');
export const getPlans = (incident: IncidentKind) => getJson<ResponsePlan[]>(`/api/plans?incident=${incident}`);
