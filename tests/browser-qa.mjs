// Uses an existing local Chromium CDP endpoint; no npm dependencies.
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const temp=await fs.mkdtemp(path.join(tmpdir(),'sharecost-qa-'));
await fs.mkdir('qa',{recursive:true});
const child=spawn('python3',['server.py','--port','8766'],{env:{...process.env,SHARECOST_DB:path.join(temp,'qa.sqlite3')},stdio:'ignore'});
let ws;
try {
  for(let n=0;n<50;n++){try{if((await fetch('http://127.0.0.1:8766')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const version=await (await fetch('http://127.0.0.1:9224/json/version')).json();
  ws=new WebSocket(version.webSocketDebuggerUrl);
  await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let seq=0;const pending=new Map(),errors=[];
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text+': '+m.params.exceptionDetails.exception?.description);});
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  const {browserContextId}=await call('Target.createBrowserContext');
  const {targetId}=await call('Target.createTarget',{url:'about:blank',browserContextId});
  const {sessionId:s}=await call('Target.attachToTarget',{targetId,flatten:true});
  await call('Page.enable',{},s);await call('Runtime.enable',{},s);
  await call('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(navigator,'language',{value:'en-US'})"},s);
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},s);if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description);return r.result.value;};
  const wait=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,60));}throw new Error('Timed out: '+expression);};
  const click=async selector=>{assert(await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),'Missing '+selector);await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);};
  const set=async (selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const submit=async selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
  const screenshot=async name=>{const r=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},s);await fs.writeFile('qa/'+name+'.png',Buffer.from(r.data,'base64'));};
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false},s);
  await call('Page.navigate',{url:'http://127.0.0.1:8766'},s);
  await wait(`document.querySelector('.stat-card')`);
  assert.equal(await evaluate('document.documentElement.lang'),'en');
  const unchanged=await evaluate('JSON.stringify(state.data)');
  await click('[data-action=language]');
  assert.equal(await evaluate('document.documentElement.lang'),'zh-CN');
  assert.equal(await evaluate('document.querySelector("h1").textContent'),'账本总览');
  assert.equal(await evaluate('JSON.stringify(state.data)'),unchanged,'Language must not mutate ledger data');
  await click('[data-action=language]');
  await call('Page.reload',{},s);
  await wait(`document.querySelector('.stat-card')`);
  assert.equal(await evaluate('document.documentElement.lang'),'en','Saved language must survive reload');
  assert.equal(await evaluate('document.querySelector("h1").textContent'),'Overview');
  for(const page of ['overview','entries','charts','settle','members','settings']) {
    await click(`[data-page=${page}]`);
    const untranslated=await evaluate("document.querySelector('main').innerText.replaceAll('中文','').match(/[\\u4e00-\\u9fff]+/gu)");
    assert.equal(untranslated,null,'Untranslated UI on '+page+': '+untranslated);
  }
  await click('[data-page=entries]');await set('#search','Food');
  assert.equal(await evaluate('document.querySelectorAll(".entry").length'),2,'Search must match translated categories');
  await click('[data-page=overview]');
  await click('[data-entry]');
  assert.equal(await evaluate("document.querySelector('#modal').innerText.replaceAll('中文','').match(/[\\u4e00-\\u9fff]+/gu)"),null,'English transaction details');
  await click('[data-action=close]');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  await screenshot('desktop');
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},s);
  await screenshot('mobile');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'Mobile overflow');
  for(const page of ['overview','entries','charts','settle','members','settings']) {
    await click(`[data-page=${page}]`);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,page+' English mobile overflow');
  }
  await click('[data-page=overview]');
  // Real registration, creating a ledger and saving expense/income through forms.
  await click('[data-action=register]');
  await set('[name=name]','界面测试');await set('[name=email]','browser@example.com');await set('[name=password]','browser-password');
  await submit('#auth-form');
  await wait(`!document.querySelector('#modal').open`);
  assert.equal(await evaluate('!!document.querySelector(".welcome .language-toggle")'),true,'Language switch before creating a ledger');
  await click('[data-action=language]');await click('[data-action=language]');
  assert(await evaluate("document.body.innerText.includes('界面测试')"),'User name must remain unchanged');
  await click('[data-action=new-book]');await set('[name=name]','测试生活账本');await set('[name=budget]','5000');await submit('#book-form');
  await wait(`document.querySelector('.stat-card')&&!document.querySelector('#modal').open`);
  await click('[data-action=add]');await set('[name=amount]','99.99');await set('[name=note]','浏览器保存测试');await submit('#entry-form');
  await wait(`!document.querySelector('#modal').open`);
  assert(await evaluate(`document.body.innerText.includes('99.99')`));
  await click('[data-entry]');await click('[data-edit]');await set('[name=amount]','120.01');await submit('#entry-form');
  await wait(`document.querySelector('.form-error').textContent.includes('add up')`);
  await set('[name=split_mode]','equal');await submit('#entry-form');
  await wait(`!document.querySelector('#modal').open`);
  assert(await evaluate(`document.body.innerText.includes('120.01')`));
  const beforeSwitch=await evaluate('JSON.stringify(state.data)');
  await click('[data-page=entries]');await set('#search','浏览器保存');
  await click('[data-action=language]');
  assert.equal(await evaluate('JSON.stringify(state.data)'),beforeSwitch,'Real transaction data must remain unchanged');
  assert.equal(await evaluate('document.querySelector("#search").value'),'浏览器保存','Search is preserved');
  await click('[data-action=language]');
  assert(await evaluate("document.body.innerText.includes('测试生活账本')"),'User ledger name must not be translated');
  assert(await evaluate("document.body.innerText.includes('浏览器保存测试')"),'User note must not be translated');
  assert.equal(await evaluate('state.data.entries[0].category'),'餐饮','Stored category must remain compatible');
  await evaluate('URL.createObjectURL = blob => { globalThis.exportedCSV=blob; return "blob:test"; };');
  await click('[data-action=export]');
  const csv=await evaluate('exportedCSV.text()');
  assert(csv.includes('"Date","Type","Category"'),'English CSV headers');
  assert(csv.includes('Food & drinks'),'English CSV categories');
  assert(csv.includes('浏览器保存测试'),'CSV preserves user notes');
  await click('[data-action=add]');await click('[data-kind=income]');await set('[name=amount]','1000');await set('[name=note]','个人工资');await submit('#entry-form');
  await wait(`!document.querySelector('#modal').open`);
  for (const page of ['entries','charts','settle','members','settings']){
    await click(`[data-page=${page}]`);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,page+' mobile overflow');
  }
  await click('[data-page=entries]');await set('#search','浏览器保存');
  assert.equal(await evaluate(`document.querySelectorAll('.entry').length`),1);
  await click('[data-entry]');await click('[data-delete]');await click('#confirm-do');
  await wait(`!document.querySelector('#modal').open`);
  assert.equal(await evaluate(`document.querySelectorAll('.entry').length`),0);
  await click('[data-action=logout]');
  await wait(`document.querySelector('.demo-banner')`);
  assert.deepEqual(errors,[],'Browser runtime errors');
  console.log('PASS: English/Chinese switching and persistence; translated categories, errors and CSV; unchanged user content and data; desktop/mobile layout; registration; create ledger; expense/income; edit; search; delete; all views; logout. No runtime exceptions.');
  await call('Target.disposeBrowserContext',{browserContextId});
} finally {
  ws?.close();child.kill();
  await new Promise(r=>child.once('exit',r));
  await fs.rm(temp,{recursive:true,force:true});
}
