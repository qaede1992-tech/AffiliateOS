import assert from "node:assert/strict";
import test from "node:test";
import { createShopeeAffiliateProvider } from "../src/domain/shopee-affiliate-runtime.js";

test("Shopee runtime factory stays disabled without complete runtime credentials",()=>{
  assert.equal(createShopeeAffiliateProvider({credentialReference:"secret://affiliateos/shopee/production",appId:"123",market:"ID",apiVersion:"v2"}),undefined);
  assert.equal(createShopeeAffiliateProvider({credentialReference:"secret://affiliateos/shopee/production",appSecret:"secret",market:"ID",apiVersion:"v2"}),undefined);
});

test("Shopee runtime factory creates an official provider without exposing credentials",()=>{
  const provider=createShopeeAffiliateProvider({credentialReference:"secret://affiliateos/shopee/production",appId:"123",appSecret:"secret",market:"ID",apiVersion:"v2"});
  assert.ok(provider);
  assert.equal(provider.slug,"shopee-affiliate");
  assert.equal(provider.connectionMode,"official_api");
  assert.deepEqual(provider.capabilities,["discoverProducts","searchProducts","getProduct","getOffers","generateAffiliateLink","syncConversions"]);
});

test("Shopee runtime factory rejects unsafe credential references",()=>{
  assert.throws(()=>createShopeeAffiliateProvider({credentialReference:"secret value",appId:"123",appSecret:"secret",market:"ID",apiVersion:"v2"}),/opaque secret-manager reference/);
});


test("Shopee runtime provider rejects a connection bound to another credential reference or runtime market",()=>{
  const provider=createShopeeAffiliateProvider({credentialReference:"secret://affiliateos/shopee/production",appId:"123",appSecret:"secret",market:"ID",apiVersion:"v2"});
  assert.ok(provider);
  assert.throws(()=>provider.validateConfiguration({market:"ID",apiVersion:"v2"},"secret://affiliateos/shopee/other"),/credential reference/);
  assert.throws(()=>provider.validateConfiguration({market:"MY",apiVersion:"v2"},"secret://affiliateos/shopee/production"),/does not match/);
});
