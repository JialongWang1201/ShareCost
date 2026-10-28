import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../web/i18n.js',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
function context(saved=null,browser='en-US') {
  const meta={},dialog={setAttribute(){}},document={documentElement:{},querySelector(selector){return selector.startsWith('meta')?meta:selector==='#modal'?dialog:null;}};
  const ctx=vm.createContext({document,navigator:{language:browser},localStorage:{getItem(){return saved;}}});
  vm.runInContext(source,ctx);
  return ctx;
}

test('language selection respects saved choices, browser language, and invalid preferences',()=>{
  for(const [saved,browser,expected] of [[null,'en-CA','en'],[null,'zh-TW','zh'],['zh','en-US','zh'],['en','zh-CN','en'],['invalid','en-US','en']]){
    const ctx=context(saved,browser);
    assert.equal(vm.runInContext('language',ctx),expected);
    assert.equal(ctx.document.documentElement.lang,expected==='zh'?'zh-CN':'en');
  }
});

test('all explicit UI keys and backend validation messages have English translations',()=>{
  const ctx=context();
  const keys=[...app.matchAll(/\bt\("([^"\n]+)"\)/g)].map(m=>m[1]);
  const server=fs.readFileSync(new URL('../server.py',import.meta.url),'utf8');
  keys.push(...[...server.matchAll(/raise ApiError\('([^']+)'/g)].map(m=>m[1]));
  for(const key of keys){
    const translated=vm.runInContext(`t(${JSON.stringify(key)})`,ctx);
    assert(!/[\u4e00-\u9fff]/u.test(translated),`Missing English translation: ${key}`);
  }
  assert.equal(vm.runInContext('t("账本名称不能为空，且最多 32 个字符")',ctx),'Ledger name is required and must be at most 32 characters.');
  assert.equal(vm.runInContext('t("自定义账本名称")',ctx),'自定义账本名称','Unknown values must not be rewritten.');
});
