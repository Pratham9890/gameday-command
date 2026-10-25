import {describe,expect,it} from 'vitest';
import {readRole,saveRole} from './roles.ts';
describe('demo role storage',()=>{
  it('writes only role and unit, without credentials or other user data',()=>{
    const values=new Map<string,string>(),store={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};
    saveRole({role:'officer',unitId:'off-4'},store);
    expect([...values.keys()]).toEqual(['gd-demo-role','gd-demo-unit']);
    expect(readRole(store)).toEqual({role:'officer',unitId:'off-4'});
  });
  it('works without storage and rejects unknown unit values',()=>{
    const broken={getItem:()=>{throw Error('disabled');},setItem:()=>{throw Error('disabled');}};
    expect(()=>saveRole({role:'supervisor',unitId:null},broken)).not.toThrow();
    expect(readRole(broken)).toEqual({role:'supervisor',unitId:null});
    expect(readRole({getItem:()=>'<script>',setItem:()=>{}}).unitId).toBeNull();
  });
});
