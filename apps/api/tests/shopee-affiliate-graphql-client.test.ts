import assert from "node:assert/strict";
import test from "node:test";
import { ShopeeAffiliateGraphqlClient } from "../src/domain/shopee-affiliate-graphql-client.js";

test("ShopeeAffiliateGraphqlClient signs and maps discovery",async()=>{

    const requests:RequestInit[]=[];
    const client=new ShopeeAffiliateGraphqlClient({market:"ID",credentials:{appId:"123",secret:"secret"},now:()=>1700000000000,fetchImpl:async(_input,init)=>{
      requests.push(init||{});
      return new Response(JSON.stringify({data:{productOfferV2:{nodes:[{itemId:99,productName:"Test product",productLink:"https://shopee.co.id/product/99",offerLink:"https://shopee.co.id/offer/99",priceMin:"125000",priceMax:"150000",priceDiscountRate:20,sales:321,ratingStar:"4.7",commissionRate:"0.25",commission:"31250",shopId:7,shopName:"Test Shop",shopType:[1],periodEndTime:1800000000}],pageInfo:{page:1,limit:50,hasNextPage:false}}}}),{status:200});
    }});
    const products=await client.productOfferV2();
    assert.deepEqual(products[0],{...products[0],externalProductId:"99",name:"Test product",priceCents:12500000,soldCount:321,ratingMilli:4700,productUrl:"https://shopee.co.id/product/99"});
    assert.equal(requests.length,1); assert.match((requests[0].headers as Record<string,string>).authorization,/Credential=123/); assert.match(String(requests[0].body),/"query"/);
});
test("ShopeeAffiliateGraphqlClient generates a short link",async()=>{
    const client=new ShopeeAffiliateGraphqlClient({market:"ID",credentials:{appId:"123",secret:"secret"},fetchImpl:async(_i,init)=>{
      const body=String(init&&init.body);
      assert.match(body,/generateShortLink/);
      assert.match(body,/originUrl/);
      return new Response(JSON.stringify({data:{generateShortLink:{shortLink:"https://shope.ee/example"}}}),{status:200});
    }});
    assert.deepEqual(await client.generateShortLink("https://shopee.co.id/product/99"),{url:"https://shope.ee/example"});
});
test("ShopeeAffiliateGraphqlClient rejects non-URL offer references",async()=>{
    const client=new ShopeeAffiliateGraphqlClient({market:"ID",credentials:{appId:"123",secret:"secret"},fetchImpl:async()=>{throw new Error("network must not be called");}});
    await assert.rejects(client.generateShortLink("offer-99"),/original Shopee URL/);
});