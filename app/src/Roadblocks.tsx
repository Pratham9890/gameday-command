import {VEHICLE_STATES,type MapBundle,type VehicleFrame} from '../../contracts.ts';
import type {SceneInfo} from '../../engine/src/edits.ts';
import {closedAreas} from './barricadeArt.ts';
import {clockText} from './story.ts';
/** Counts observations near a closure; makes no causal claim about its effect. */
export function Roadblocks({map,scene,vehicles,onFocus}:{map:MapBundle;scene:SceneInfo|null;vehicles?:VehicleFrame;onFocus?:(cell:number)=>void}) {
 const areas=closedAreas(map,scene).filter(b=>!b.isGate);
 return <section><h3>Roadblocks</h3><p className="muted">Jersey barrier: vehicles only. Bike-rack fence: pedestrians only. Combined: both. Stopped counts are observations within 50 m, not attributed delay.</p>{!areas.length&&<p className="muted">No roadblocks up.</p>}<ul className="roadblocks">{areas.map(b=>{
 const last=[...(scene?.orders??[])].reverse().find(e=>e.order.type==='barricade'&&e.order.closableId===b.id&&e.order.closed);
 let stopped=0;if(vehicles)for(let i=0;i<vehicles.x.length;i++){if(VEHICLE_STATES[vehicles.state[i]!]!=='stopped')continue;if(Math.hypot(vehicles.x[i]!-b.x,vehicles.y[i]!-b.y)<=50)stopped++;}
 return <li key={b.id}><button className="ghost" onClick={()=>onFocus?.(b.cells[Math.floor(b.cells.length/2)]!)}>{b.name}</button><span>{b.blocks??'all'} blocked. {last?'Live order at '+clockText(last.t):'Plan step'}. {stopped} stopped vehicles within 50 m.</span></li>;
 })}</ul></section>;
}
