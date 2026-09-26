import { describe, expect, it } from "vitest";
import { ShopeeAffiliateGraphqlClient } from "../src/domain/shopee-affiliate-graphql-client.js";

describe("ShopeeAffiliateGraphqlClient",()=>{
  it("signs the exact JSON body and maps discovery fields",async()=>{
    const requests:RequestInit[]=[];
    const client=new ShopeeAffiliateGraphqlClient({market:"ID",credentials:{appId:"123",secret:"secret"},now:()=>1700000000000,fetchImpl:async(_input,init)=>{
      requests.push(init||{});
      return new Response(JSON.stringify({data:{productOfferV2:{nodes:[{itemId:99,productName:"Test product",productLink:"https://shopee.co.id/product/99",offerLink:"https://shopee.co.id/offer/99",priceMin:"125000",priceMax:"150000",priceDiscountRate:20,sales:321,ratingStar:"4.7",commissionRate:"0.25",commission:"31250",shopId:7,shopName:"Test Shop",shopType:[1],periodEndTime:1800000000}],pageInfo:{page:1,limit:50,hasNextPage:false}}}}),{status:200});
    }});
    const products=await client.productOfferV2();
    expect(products[0]).toMatchObject({externalProductId:"99",name:"Test product",priceCents:12500000,soldCount:321,ratingMilli:4700,productUrl:"https://shopee.co.id/product/99"});
    expect(requests).toHaveLength(1); expect(String(requests[0].headers)).toContain("Credential=123"); expect(String(requests[0].body)).toContain('"query"');
  });
  it("generates a short link from an offer URL",async()=>{
    const client=new ShopeeAffiliateGraphqlClient({market:"ID",credentials:{appId:"123",secret:"secret"},fetchImpl:async(_i,init)=>{
      expect(String(init&&init.body)).toContain("GenerateShortLink"); expect(String(init&&init.body)).toContain("originUrl");
      return new Response(JSON.stringify({data:{generateShortLink:{shortLink:"https://shope.ee/example"}}}),{status:200});
    }});
    await expect(client.generateShortLink("https://shopee.co.id/product/99")).resolves.toEqual({url:"https://shope.ee/example"});
  });
  it("rejects non-URL offer references before network access",async()=>{
    const client=new ShopeeAffiliateGraphqlClient({market:"ID",credentials:{appId:"123",secret:"secret"},fetchImpl:async()=>{throw new Error("network must not be called");}});
    await expect(client.generateShortLink("offer-99")).rejects.toThrow("original Shopee URL");
  });
});