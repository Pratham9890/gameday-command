/** Static spatial index with live eligibility checks. Equal distances retain
 * the original cell-list order, so it is exactly the same choice as a scan. */
interface Node {x0:number;y0:number;x1:number;y1:number;items?:{cell:number;index:number}[];left?:Node;right?:Node}
export class NearestCells {
  private readonly width:number;
  private readonly root:Node|null;
  constructor(cells:readonly number[],width:number) {
    this.width=width;
    const build=(items:{cell:number;index:number}[]):Node=>{
      let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
      for(const v of items){const x=v.cell%width+.5,y=Math.floor(v.cell/width)+.5;x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}
      const node:Node={x0,y0,x1,y1};
      if(items.length<=16)node.items=items;
      else {
        const horizontal=x1-x0>=y1-y0;
        items.sort((a,b)=>(horizontal?a.cell%width-b.cell%width:Math.floor(a.cell/width)-Math.floor(b.cell/width))||a.index-b.index);
        const mid=items.length>>>1;node.left=build(items.slice(0,mid));node.right=build(items.slice(mid));
      }
      return node;
    };
    this.root=cells.length?build(cells.map((cell,index)=>({cell,index}))):null;
  }
  nearest(x:number,y:number,allowed:(cell:number)=>boolean):number {
    let cell=-1,index=Infinity,distance=Infinity;
    const bound=(n:Node)=>Math.max(n.x0-x,0,x-n.x1)**2+Math.max(n.y0-y,0,y-n.y1)**2;
    const visit=(node:Node)=>{
      if(bound(node)>distance)return;
      if(node.items) {
        for(const v of node.items){
          const dx=v.cell%this.width+.5-x,dy=Math.floor(v.cell/this.width)+.5-y,d=dx*dx+dy*dy;
          if((d<distance||(d===distance&&v.index<index))&&allowed(v.cell)){distance=d;cell=v.cell;index=v.index;}
        }
      } else {
        const left=node.left!,right=node.right!;
        if(bound(left)<=bound(right)){visit(left);visit(right);}else{visit(right);visit(left);}
      }
    };
    if(this.root)visit(this.root);return cell;
  }
}
