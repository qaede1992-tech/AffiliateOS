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

test("ShopeeAffiliateGraphqlClient maps detailed conversion reports and paginates",async()=>{
 let calls=0;
 const client=new ShopeeAffiliateGraphqlClient({market:"ID",credentials:{appId:"123",secret:"secret"},pageSize:2,fetchImpl:async(_i,init)=>{
   calls++; const body=String(init?.body); assert.match(body,/conversionReport/);
   const second=calls===2;
   return new Response(JSON.stringify({data:{conversionReport:{nodes:second?[{conversionId:102,purchaseTime:1700000200,totalCommission:"15000",netCommission:"12000",utmContent:"ig-02",orders:[{orderId:"ord-2",orderStatus:"COMPLETED",items:[{itemId:99,itemName:"Kettle",itemPrice:"125000",actualAmount:"100000",qty:1,itemTotalCommission:"15000",shopId:7,shopName:"Shop",completeTime:1700000300}]}]}]:[{conversionId:101,purchaseTime:1700000100,clickTime:1700000000,totalCommission:"25000",sellerCommission:"20000",shopeeCommissionCapped:"5000",utmContent:"ig-01",buyerType:"New",device:"APP",referrer:"instagram",orders:[]}],pageInfo:second?{hasNextPage:false}:{hasNextPage:true,scrollId:"next-page"}}}}),{status:200});
 }});
 const rows=await client.conversionReportDetailed("2023-11-14T00:00:00.000Z");
 assert.equal(calls,2); assert.equal(rows.length,2); assert.equal(rows[0]?.totalCommissionCents,2500000); assert.equal(rows[0]?.clickTime,"2023-11-14T22:13:20.000Z"); assert.equal(rows[1]?.netCommissionCents,1200000); assert.equal(rows[1]?.orders[0]?.items[0]?.actualAmountCents,10000000);
});
