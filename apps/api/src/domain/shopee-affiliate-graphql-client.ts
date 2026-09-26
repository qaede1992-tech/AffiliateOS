import { createHash } from "node:crypto";
import type { MarketplaceOfferInput, MarketplaceProductInput } from "@affiliateos/shared";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface ShopeeAffiliateCredentials { appId: string; secret: string; }
export interface ShopeeAffiliateGraphqlClientOptions { market:string; credentials:ShopeeAffiliateCredentials; fetchImpl?:FetchLike; subIds?:string[]; now?:()=>number; pageSize?:number; }
interface ProductNode { itemId:string|number; productName:string; productLink:string; offerLink?:string; imageUrl?:string; priceMin?:string; priceMax?:string; priceDiscountRate?:number; sales?:number; ratingStar?:string; commissionRate?:string; sellerCommissionRate?:string; shopeeCommissionRate?:string; commission?:string; shopId?:string|number; shopName?:string; shopType?:number[]; periodStartTime?:number; periodEndTime?:number; productCatIds?:number[]; }
interface ProductConnection { nodes:ProductNode[]; pageInfo:{page:number;limit:number;hasNextPage:boolean}; }
interface GraphqlResponse<T> { data?:T; errors?:Array<{message?:string;extensions?:{code?:string|number}}>; }
export interface ShopeeAffiliateConversionReportItem {
  conversionId: string;
  purchaseTime: string;
  clickTime?: string;
  totalCommissionCents?: number;
  netCommissionCents?: number;
  sellerCommissionCents?: number;
  shopeeCommissionCappedCents?: number;
  utmContent?: string;
  buyerType?: string;
  device?: string;
  referrer?: string;
  orders: Array<{ orderId: string; orderStatus?: string; items: Array<{ itemId: string; itemName?: string; itemPriceCents?: number; actualAmountCents?: number; qty?: number; itemTotalCommissionCents?: number; shopId?: string; shopName?: string; completeTime?: string }> }>;
}

const ENDPOINTS:Record<string,string>={ID:"https://open-api.affiliate.shopee.co.id/graphql",MY:"https://open-api.affiliate.shopee.com.my/graphql",SG:"https://open-api.affiliate.shopee.sg/graphql",TH:"https://open-api.affiliate.shopee.co.th/graphql",VN:"https://open-api.affiliate.shopee.vn/graphql",PH:"https://open-api.affiliate.shopee.ph/graphql",TW:"https://open-api.affiliate.shopee.tw/graphql",BR:"https://open-api.affiliate.shopee.com.br/graphql"};
const PRODUCT_FIELDS="itemId productName productLink offerLink imageUrl priceMin priceMax priceDiscountRate sales ratingStar commissionRate sellerCommissionRate shopeeCommissionRate commission shopId shopName shopType periodStartTime periodEndTime productCatIds";

export class ShopeeAffiliateGraphqlClient {
  private readonly endpoint:string; private readonly fetchImpl:FetchLike; private readonly now:()=>number; private readonly subIds:string[]; private readonly pageSize:number;
  constructor(private readonly options:ShopeeAffiliateGraphqlClientOptions){
    const market=options.market.trim().toUpperCase();
    this.endpoint=ENDPOINTS[market] || (()=>{ throw new Error("Unsupported Shopee Affiliate market: "+market); })();
    this.fetchImpl=options.fetchImpl || fetch; this.now=options.now || (()=>Date.now()); this.subIds=(options.subIds||[]).slice(0,5); this.pageSize=Math.min(50,Math.max(1,options.pageSize||50));
    if(!options.credentials.appId.trim()||!options.credentials.secret) throw new Error("Shopee Affiliate App ID and secret are required at runtime.");
  }
  async testConnection():Promise<Record<string,unknown>>{ await this.request<{productOfferV2:ProductConnection}>("query { productOfferV2(page: 1, limit: 1) { nodes { itemId } pageInfo { page limit hasNextPage } } }"); return {endpoint:this.endpoint,market:this.options.market.toUpperCase(),authenticated:true}; }
  productOfferV2():Promise<MarketplaceProductInput[]>{return this.fetchProducts({});}
  searchProductOffers(query:string):Promise<MarketplaceProductInput[]>{return this.fetchProducts({keyword:query.trim()});}
  async getProduct(externalProductId:string):Promise<MarketplaceProductInput|undefined>{const itemId=normalizeItemId(externalProductId); return (await this.fetchProducts({itemId}))[0];}
  shopOfferV2():Promise<MarketplaceProductInput[]>{throw new Error("Shopee shopOfferV2 is not a product catalogue operation.");}
  async getOffers(externalProductId:string):Promise<MarketplaceOfferInput[]>{const itemId=normalizeItemId(externalProductId); return (await this.fetchProductNodes({itemId})).map(n=>this.toOffer(n)).filter((x):x is MarketplaceOfferInput=>Boolean(x));}
  async generateShortLink(externalOfferId:string):Promise<{url:string}>{
    const originUrl=externalOfferId.trim(); if(!/^https?:\/\//i.test(originUrl)) throw new Error("Shopee affiliate offer reference must be the original Shopee URL.");
    const subIds=this.subIds.length?"["+this.subIds.map((id)=>JSON.stringify(id)).join(",")+"]":"[]";
    const query="mutation { generateShortLink(input: { originUrl: "+JSON.stringify(originUrl)+", subIds: "+subIds+" }) { shortLink } }";
    const result=await this.request<{generateShortLink:{shortLink:string}}>(query);
    const url=result.generateShortLink&&result.generateShortLink.shortLink; if(!url) throw new Error("Shopee did not return an affiliate short link."); return {url};
  }
  async conversionReport(since:string):Promise<{synced:number}>{
    const start=Math.floor(Date.parse(since)/1000); if(!Number.isFinite(start)) throw new Error("Shopee conversion sync requires a valid ISO timestamp.");
    return {synced:(await this.conversionReportDetailed(since)).length};
  }
  async conversionReportDetailed(since:string):Promise<ShopeeAffiliateConversionReportItem[]>{
    const start=Math.floor(Date.parse(since)/1000); if(!Number.isFinite(start)) throw new Error("Shopee conversion sync requires a valid ISO timestamp.");
    const end=Math.floor(this.now()/1000); let scrollId:string|undefined; const results:ShopeeAffiliateConversionReportItem[]=[];
    const query="query ConversionReport($start: Int!, $end: Int!, $limit: Int!, $scrollId: String) { conversionReport(purchaseTimeStart: $start, purchaseTimeEnd: $end, limit: $limit, scrollId: $scrollId) { nodes { conversionId purchaseTime clickTime totalCommission netCommission sellerCommission shopeeCommissionCapped utmContent buyerType device referrer orders { orderId orderStatus items { itemId itemName itemPrice actualAmount qty itemTotalCommission shopId shopName completeTime } } } pageInfo { hasNextPage scrollId } } }";
    while(true){
      const r=await this.request<{conversionReport:{nodes:Array<Record<string,unknown>>;pageInfo:{hasNextPage:boolean;scrollId?:string}}}>(query,{start,end,limit:this.pageSize,scrollId});
      for(const node of r.conversionReport.nodes) results.push(this.toConversionReportItem(node));
      if(!r.conversionReport.pageInfo.hasNextPage) break;
      scrollId=r.conversionReport.pageInfo.scrollId; if(!scrollId) throw new Error("Shopee conversion report requested another page without a scrollId.");
    }
    return results;
  }
  private async fetchProducts(filters:{keyword?:string;itemId?:string}):Promise<MarketplaceProductInput[]>{return (await this.fetchProductNodes(filters)).map(n=>this.toProduct(n));}
  private async fetchProductNodes(filters:{keyword?:string;itemId?:string}):Promise<ProductNode[]>{
    const query="query ProductOffers($keyword: String, $itemId: Int64, $page: Int!, $limit: Int!) { productOfferV2(keyword: $keyword, itemId: $itemId, sortType: 2, page: $page, limit: $limit) { nodes { "+PRODUCT_FIELDS+" } pageInfo { page limit hasNextPage } } }";
    const nodes:ProductNode[]=[]; let page=1;
    while(true){const r=await this.request<{productOfferV2:ProductConnection}>(query,{keyword:filters.keyword||undefined,itemId:filters.itemId?Number(filters.itemId):undefined,page,limit:this.pageSize}); nodes.push(...r.productOfferV2.nodes); if(!r.productOfferV2.pageInfo.hasNextPage) return nodes; page++;}
  }
  private toProduct(n:ProductNode):MarketplaceProductInput{
    const price=parseDecimal(n.priceMin),rate=parseDecimal(n.commissionRate),commission=parseDecimal(n.commission),rating=parseDecimal(n.ratingStar);
    return {externalProductId:String(n.itemId),name:n.productName,category:n.productCatIds?.filter(id=>id>0).join("/"),priceCents:toMinorUnits(price)||0,originalPriceCents:discountAdjustedOriginal(price,n.priceDiscountRate),currency:this.currency(),ratingMilli:rating===undefined?undefined:Math.round(rating*1000),reviewCount:0,soldCount:Math.max(0,Math.trunc(n.sales||0)),imageUrl:n.imageUrl,productUrl:n.productLink,availability:"unknown",affiliateLinkExpiresAt:n.periodEndTime?new Date(n.periodEndTime*1000).toISOString():undefined,metadata:{shopee:{shopId:n.shopId,shopName:n.shopName,shopType:n.shopType,offerLink:n.offerLink,commissionRate:rate,sellerCommissionRate:parseDecimal(n.sellerCommissionRate),shopeeCommissionRate:parseDecimal(n.shopeeCommissionRate),commissionAmount:commission,priceMax:parseDecimal(n.priceMax),priceDiscountRate:n.priceDiscountRate,periodStartTime:n.periodStartTime,periodEndTime:n.periodEndTime},demand:{sales:Math.max(0,Math.trunc(n.sales||0))},capturedAt:new Date(this.now()).toISOString()}};
  }
  private toOffer(n:ProductNode):MarketplaceOfferInput|undefined{
    const externalOfferId=(n.offerLink||n.productLink||"").trim(); if(!externalOfferId)return undefined;
    return {externalOfferId,priceCents:toMinorUnits(parseDecimal(n.priceMin)),currency:this.currency(),commissionRateBps:rateToBps(parseDecimal(n.commissionRate)),commissionAmountCents:toMinorUnits(parseDecimal(n.commission)),availability:"unknown",affiliateLinkExpiresAt:n.periodEndTime?new Date(n.periodEndTime*1000).toISOString():undefined,metadata:{shopId:n.shopId,shopName:n.shopName,offerLink:n.offerLink,productLink:n.productLink,sellerCommissionRate:n.sellerCommissionRate,shopeeCommissionRate:n.shopeeCommissionRate}};
  }
  private toConversionReportItem(node:Record<string,unknown>):ShopeeAffiliateConversionReportItem{
    const conversionId=stringValue(node.conversionId); if(!conversionId) throw new Error("Shopee conversion report returned a conversion without an ID.");
    const purchaseTime=unixToIso(node.purchaseTime); if(!purchaseTime) throw new Error("Shopee conversion report returned a conversion without purchase time.");
    const orders=Array.isArray(node.orders)?node.orders.map((order)=>this.toConversionOrder(order)).filter((order):order is ShopeeAffiliateConversionReportItem["orders"][number]=>Boolean(order)):[];
    return {conversionId,purchaseTime,clickTime:unixToIso(node.clickTime),totalCommissionCents:moneyToMinor(node.totalCommission),netCommissionCents:moneyToMinor(node.netCommission),sellerCommissionCents:moneyToMinor(node.sellerCommission),shopeeCommissionCappedCents:moneyToMinor(node.shopeeCommissionCapped),utmContent:stringValue(node.utmContent),buyerType:stringValue(node.buyerType),device:stringValue(node.device),referrer:stringValue(node.referrer),orders};
  }
  private toConversionOrder(value:unknown):ShopeeAffiliateConversionReportItem["orders"][number]|undefined{
    if(!value||typeof value!=="object") return undefined; const order=value as Record<string,unknown>; const orderId=stringValue(order.orderId); if(!orderId)return undefined;
    const items=Array.isArray(order.items)?order.items.map((item)=>this.toConversionItem(item)).filter((item):item is ShopeeAffiliateConversionReportItem["orders"][number]["items"][number]=>Boolean(item)):[];
    return {orderId,orderStatus:stringValue(order.orderStatus),items};
  }
  private toConversionItem(value:unknown):ShopeeAffiliateConversionReportItem["orders"][number]["items"][number]|undefined{
    if(!value||typeof value!=="object")return undefined; const item=value as Record<string,unknown>; const itemId=stringValue(item.itemId); if(!itemId)return undefined;
    return {itemId,itemName:stringValue(item.itemName),itemPriceCents:moneyToMinor(item.itemPrice),actualAmountCents:moneyToMinor(item.actualAmount),qty:integerValue(item.qty),itemTotalCommissionCents:moneyToMinor(item.itemTotalCommission),shopId:stringValue(item.shopId),shopName:stringValue(item.shopName),completeTime:unixToIso(item.completeTime)};
  }
  private currency():string{return ({ID:"IDR",MY:"MYR",SG:"SGD",TH:"THB",VN:"VND",PH:"PHP",TW:"TWD",BR:"BRL"} as Record<string,string>)[this.options.market.toUpperCase()]||"USD";}
  private async request<T>(query:string,variables?:Record<string,unknown>):Promise<T>{
    const body=JSON.stringify({query,variables}),timestamp=Math.floor(this.now()/1000).toString();
    const signature=createHash("sha256").update(this.options.credentials.appId+timestamp+body+this.options.credentials.secret,"utf8").digest("hex");
    const response=await this.fetchImpl(this.endpoint,{method:"POST",headers:{"content-type":"application/json",authorization:"SHA256 Credential="+this.options.credentials.appId+", Timestamp="+timestamp+", Signature="+signature},body});
    const payload=(await response.json()) as GraphqlResponse<T>;
    if(!response.ok)throw new Error("Shopee Affiliate HTTP error: "+response.status);
    if(payload.errors&&payload.errors.length){const first=payload.errors[0]; if(!first) throw new Error("Shopee Affiliate GraphQL error: unknown error"); const code=first.extensions&&first.extensions.code?" ["+first.extensions.code+"]":"";throw new Error("Shopee Affiliate GraphQL error"+code+": "+(first.message||"unknown error"));}
    if(!payload.data)throw new Error("Shopee Affiliate returned no GraphQL data."); return payload.data;
  }
}
function stringValue(value:unknown):string|undefined{return typeof value==="string"||typeof value==="number"?String(value).trim()||undefined:undefined;}
function integerValue(value:unknown):number|undefined{return typeof value==="number"&&Number.isSafeInteger(value)?value:undefined;}
function unixToIso(value:unknown):string|undefined{const seconds=integerValue(value);return seconds===undefined?undefined:new Date(seconds*1000).toISOString();}
function moneyToMinor(value:unknown):number|undefined{const n=typeof value==="number"?value:typeof value==="string"&&value.trim()?Number(value):NaN;return Number.isFinite(n)?Math.max(0,Math.round(n*100)):undefined;}
function parseDecimal(value:string|number|undefined):number|undefined{if(value===undefined||value==="")return undefined;const n=Number(value);return Number.isFinite(n)?n:undefined;}
function toMinorUnits(value:number|undefined):number|undefined{return value===undefined?undefined:Math.max(0,Math.round(value*100));}
function rateToBps(rate:number|undefined):number|undefined{return rate===undefined?undefined:Math.max(0,Math.min(10000,Math.round(rate*10000)));}
function discountAdjustedOriginal(price:number|undefined,discountRate:number|undefined):number|undefined{if(price===undefined||discountRate===undefined||discountRate<=0||discountRate>=100)return undefined;return Math.max(toMinorUnits(price)||0,Math.round((price/(1-discountRate/100))*100));}

function normalizeItemId(value:string):string{const itemId=value.trim(); if(!/^\d+$/.test(itemId)||!Number.isSafeInteger(Number(itemId))) throw new Error("Shopee product ID must be a safe integer."); return itemId;}\n