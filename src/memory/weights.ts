const DAY=86_400_000;
export function activation(base:number, reinforcedAt:string, halfLifeDays:number, now:number):number {
  return base*2**(-Math.max(0,now-Date.parse(reinforcedAt))/(DAY*halfLifeDays));
}
export function decayedMass(mass:number, at:string, now:number):number { return mass*2**(-Math.max(0,now-Date.parse(at))/(DAY*30)); }
export function halfLife(kind:string,importance:number):number { return ['plan','correction','preference'].includes(kind)||importance>=0.8?180:kind==='chat'?7:30; }

