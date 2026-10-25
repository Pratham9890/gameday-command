export type DemoRole={role:'supervisor'|'officer';unitId:string|null};
type Store=Pick<Storage,'getItem'|'setItem'>;
export function readRole(storage?:Store):DemoRole {
  try {
    const s=storage??window.localStorage,role=s.getItem('gd-demo-role'),unit=s.getItem('gd-demo-unit');
    return {role:role==='officer'?'officer':'supervisor',unitId:unit&&/^(off-|live-off-)\d+$/.test(unit)?unit:null};
  } catch {return {role:'supervisor',unitId:null};}
}
export function saveRole(choice:DemoRole,storage?:Store):void {
  try {const s=storage??window.localStorage;s.setItem('gd-demo-role',choice.role);s.setItem('gd-demo-unit',choice.unitId??'');} catch {/* Demo access must work with storage disabled. */}
}
