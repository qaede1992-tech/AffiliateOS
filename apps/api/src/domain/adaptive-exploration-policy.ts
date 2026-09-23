import type { AutonomousDecisionAuditReader } from "./autonomous-decision-audit.js";
import type { OpportunityCandidateSource, OpportunitySelectionPoliciesByMarketplace, OpportunitySelectionPolicy } from "./autonomous-opportunity.js";
import type { AutonomousExplorationStateRepository, AutonomousExplorationState } from "./autonomous-exploration-state.js";
export type AdaptiveExplorationPolicy = { enabled?: boolean; minimumSamples?: number; minimumRate?: number; maximumRate?: number; promotionRateForReduction?: number; deprioritizationRateForIncrease?: number; reductionMultiplier?: number; increaseMultiplier?: number; };
type ExplorationGroupSignal = Pick<AutonomousExplorationState, "sampleCount" | "promotedCount" | "deprioritizedCount">;
const clamp=(v:number,min:number,max:number)=>Math.min(max,Math.max(min,v));
const normalize=(v:string)=>v.trim().toLowerCase();
const key=(m:string,d:"marketplace"|"category"|"audience",v:string)=>`${m}:${d}:${normalize(v)}`;
export class AdaptiveExplorationPolicyProvider {
 constructor(private readonly reader:AutonomousDecisionAuditReader,private readonly policy:AdaptiveExplorationPolicy={},private readonly stateRepository?:AutonomousExplorationStateRepository){}
 async getRates(candidates:OpportunityCandidateSource[],basePolicy:OpportunitySelectionPolicy,policiesByMarketplace:OpportunitySelectionPoliciesByMarketplace={}):Promise<Map<string,number>>{
  if(this.policy.enabled===false)return new Map();
  const minSamples=Math.max(1,this.policy.minimumSamples??5),promote=clamp(this.policy.promotionRateForReduction??0.6,0,1),deprioritize=clamp(this.policy.deprioritizationRateForIncrease??0.5,0,1),minRate=clamp(this.policy.minimumRate??0,0,1),maxRate=clamp(this.policy.maximumRate??0.5,minRate,1),reduce=Math.max(0,this.policy.reductionMultiplier??0.5),increase=Math.max(0,this.policy.increaseMultiplier??1.5);
  const audits=await this.reader.list({selected:true,limit:500});
  if(this.stateRepository)await this.stateRepository.applyEvaluatedAudits(audits);
  const signals=new Map<string,ExplorationGroupSignal>();
  if(this.stateRepository){const states=await this.stateRepository.listByMarketplaces([...new Set(candidates.map(c=>c.product.marketplaceId))]);for(const s of states)signals.set(key(s.marketplaceId,s.dimension,s.dimensionKey),s);}
  else for(const a of audits){const e=a.outcome?.explorationEvaluation;if(a.selectionMode!=="exploration"||!e||!["promote-to-exploitation","deprioritize"].includes(e.status))continue;const add=(d:"marketplace"|"category"|"audience",v:string)=>{const k=key(a.marketplaceId,d,v),s=signals.get(k)??{sampleCount:0,promotedCount:0,deprioritizedCount:0};s.sampleCount++;if(e.status==="promote-to-exploitation")s.promotedCount++;else s.deprioritizedCount++;signals.set(k,s);};add("marketplace",a.marketplaceId);if(a.category)add("category",a.category);for(const v of a.audienceSegments??[])add("audience",String(v));}
  const rates=new Map<string,number>();
  for(const c of candidates){const p={...basePolicy,...(policiesByMarketplace[c.product.marketplaceId]??{})};let rate=clamp(p.explorationRate??0.2,minRate,maxRate);let specific=false;const cat=c.product.category?.trim(),cs=cat?signals.get(key(c.product.marketplaceId,"category",cat)):undefined;if(cs&&cs.sampleCount>=minSamples){rate=this.adjust(rate,cs,promote,deprioritize,reduce,increase,minRate,maxRate);specific=true;}if(!specific){for(const a of p.requiredAudience??[]){const as=signals.get(key(c.product.marketplaceId,"audience",String(a)));if(as&&as.sampleCount>=minSamples){rate=this.adjust(rate,as,promote,deprioritize,reduce,increase,minRate,maxRate);specific=true;break;}}}if(!specific){const m=signals.get(key(c.product.marketplaceId,"marketplace",c.product.marketplaceId));if(m&&m.sampleCount>=minSamples)rate=this.adjust(rate,m,promote,deprioritize,reduce,increase,minRate,maxRate);}rates.set(c.product.id,rate);}
  return rates;
 }
 private adjust(rate:number,s:ExplorationGroupSignal,p:number,d:number,r:number,i:number,min:number,max:number){const pr=s.promotedCount/s.sampleCount,dr=s.deprioritizedCount/s.sampleCount;if(pr>=p&&dr<d)return clamp(rate*r,min,max);if(dr>=d&&pr<p)return clamp(rate*i,min,max);return rate;}
}