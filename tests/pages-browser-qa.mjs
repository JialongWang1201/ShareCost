// Browser check of the static Pages build under the real /ShareCost/ subpath.
// Auth requests are intercepted: no real signup or confirmation email is sent.
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';

const temp=await fs.mkdtemp(path.join(tmpdir(),'sharecost-pages-'));
await fs.symlink(path.resolve('dist'),path.join(temp,'ShareCost'),'dir');
await fs.mkdir('qa',{recursive:true});
const child=spawn('python3',['-m','http.server','8767','--bind','127.0.0.1','--directory',temp],{stdio:'ignore'});
let ws;
try {
  for(let n=0;n<50;n++){try{if((await fetch('http://127.0.0.1:8767/ShareCost/')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const version=await(await fetch('http://127.0.0.1:9224/json/version')).json();
  ws=new WebSocket(version.webSocketDebuggerUrl);
  await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let sequence=0;const pending=new Map(),errors=[],authCalls=[];
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  ws.addEventListener('message',async event=>{
    const message=JSON.parse(event.data);
    if(message.id){const p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(new Error(JSON.stringify(message.error))):p.resolve(message.result);}}
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
    if(message.method==='Fetch.requestPaused') {
      const request=message.params.request;
      authCalls.push(request.url);
      const signup=request.url.includes('/signup');
      const body=signup?{id:'10000000-0000-0000-0000-000000000001',email:'browser@example.com',user_metadata:{name:'Cloud Test'},identities:[]}:{code:400,error_code:'email_not_confirmed',msg:'Email not confirmed'};
      try{await call('Fetch.fulfillRequest',{
        requestId:message.params.requestId,responseCode:request.method==='OPTIONS'?204:signup?200:400,
        responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:'http://127.0.0.1:8767'},{name:'Access-Control-Allow-Headers',value:'*'},{name:'Access-Control-Allow-Methods',value:'GET,POST,PUT,DELETE,OPTIONS'}],
        body:Buffer.from(request.method==='OPTIONS'?'':JSON.stringify(body)).toString('base64')
      },message.sessionId);}catch(error){errors.push(error.message);}
    }
  });
  const {browserContextId}=await call('Target.createBrowserContext');
  const {targetId}=await call('Target.createTarget',{url:'about:blank',browserContextId});
  const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
  await call('Page.enable',{},sessionId);await call('Runtime.enable',{},sessionId);
  await call('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(navigator,'language',{value:'en-US'})"},sessionId);
  await call('Fetch.enable',{patterns:[{urlPattern:'https://*.supabase.co/auth/v1/*'}]},sessionId);
  const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description);return result.result.value;};
  const wait=async expression=>{for(let n=0;n<150;n++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,70));}throw new Error('Timeout: '+expression+'; '+await evaluate('document.querySelector("#modal").innerText'));};
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const set=(selector,value)=>evaluate(`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)}`);
  const submit=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId);
  await call('Page.navigate',{url:'http://127.0.0.1:8767/ShareCost/'},sessionId);
  await wait('!!document.querySelector(".stat-card")');
  assert.equal(await evaluate('ShareCostBackend.cloud'),true);
  assert.equal(await evaluate('document.querySelector(".brand").pathname'),'/ShareCost/');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  await click('[data-action=register]');
  await set('[name=name]','Cloud Test');await set('[name=email]','browser@example.com');await set('[name=password]','browser-password');
  await submit('#auth-form');
  await wait('document.querySelector("#modal h2").textContent==="Check your email"');
  assert.equal(await evaluate('state.demo'),true,'Email-confirmation signup must not claim a signed-in session');
  await click('[data-action=login]');await set('[name=email]','browser@example.com');await set('[name=password]','browser-password');
  await submit('#auth-form');
  await wait('document.querySelector(".form-error").textContent.includes("confirm your email")');
  await click('[data-action=close]');
  await click('[data-action=language]');
  assert.equal(await evaluate('document.documentElement.lang'),'zh-CN');
  assert.equal(await evaluate('document.querySelector("h1").textContent'),'账本总览');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  const screenshot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},sessionId);
  await fs.writeFile('qa/cloud-pages-mobile.png',Buffer.from(screenshot.data,'base64'));
  assert(authCalls.some(url=>url.includes('/signup')));
  assert(authCalls.some(url=>url.includes('/token')));
  assert.deepEqual(errors,[]);
  console.log('PASS: static /ShareCost/ paths, real bundled SDK, cloud mode, email-confirmation signup, localized auth errors, language switch and mobile layout. No real users or emails created.');
  await call('Target.disposeBrowserContext',{browserContextId});
} finally {
  ws?.close();child.kill();await new Promise(r=>child.once('exit',r));
  await fs.rm(temp,{recursive:true,force:true});
}
