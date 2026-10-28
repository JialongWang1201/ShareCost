import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../web/backend.js',import.meta.url),'utf8');
function backend(supabase,cloud=true) {
  const ctx=vm.createContext({
    window:{SHARECOST_CONFIG:{backend:cloud?'supabase':'local'}},
    document:{baseURI:'https://example.github.io/ShareCost/'},URL,
    fetch:async(url,options)=>({status:200,json:async()=>({url,method:options.method})}),
    supabase
  });
  // Inject at the module boundary, without changing the production transport.
  const script=source.replace('const supabase=await client();','const supabase=globalThis.supabase;');
  vm.runInContext(script,ctx);
  return ctx.window.ShareCostBackend;
}
function client(overrides={}) {
  return {auth:{
    getSession:async()=>({data:{session:{access_token:'test'}},error:null}),
    getUser:async()=>({data:{user:{id:'a',email:'a@example.com',user_metadata:{name:'Original 中文'}}},error:null}),
    signUp:async()=>({data:{session:null},error:null}),
    signInWithPassword:async()=>({error:null}),signOut:async()=>({error:null}),
    ...overrides
  },rpc:async(name,payload)=>({data:{name,payload},error:null})};
}

test('cloud auth validates the current user and preserves names',async()=>{
  const transport=backend(client());
  const me=await transport.request('/me');
  assert.equal(me.body.user.name,'Original 中文');
  assert.equal((await backend(client({getSession:async()=>({data:{session:null}})})).request('/me')).status,401);
  assert.equal((await transport.request('/register',{name:'Alex',email:'a@example.com',password:'password123'})).body.confirmation_required,true);
  assert.equal((await transport.request('/register',{name:'',email:'a@example.com',password:'password123'})).status,400);
  assert.equal((await transport.request('/register',{name:'Alex',email:'a@example.com',password:'short'})).status,400);
  const pending=backend(client({signInWithPassword:async()=>({error:{code:'email_not_confirmed',status:400}})}));
  assert.equal((await pending.request('/login',{email:'a@example.com',password:'password123'})).body.error,'请先确认邮箱，再登录');
});

test('cloud RPC preserves API methods and errors; local mode keeps Python API',async()=>{
  const transport=backend(client());
  const read=await transport.request('/books');
  assert.equal(read.body.name,'sharecost_api');assert.equal(read.body.payload.p_data,null);
  const write=await transport.request('/entries',{amount:'1.01'});
  assert.equal(write.body.payload.p_data.amount,'1.01');
  const failed=client();failed.rpc=async()=>({data:{error:'你无权访问这个账本',status:403}});
  assert.equal((await backend(failed).request('/books/other')).status,403);
  failed.rpc=async()=>({error:{code:'PGRST202',message:'Missing'}});
  assert.equal((await backend(failed).request('/books')).status,503);
  const local=await backend(null,false).request('/books');
  assert.equal(local.body.url,'/api/books');assert.equal(local.body.method,'GET');
});

test('Pages build uses relative paths and publishes no database or private keys',async()=>{
  const html=await fs.readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  assert(!/(?:src|href)="\/(?!\/)/.test(html),'Assets must work under /ShareCost/');
  assert(html.includes('connect-src'));
  const config=await fs.readFile(new URL('../dist/config.js',import.meta.url),'utf8');
  assert(config.includes('"backend":"supabase"'));
  assert(!config.includes('sb_secret_'));
  const files=await fs.readdir(new URL('../dist/',import.meta.url));
  assert(!files.includes('data'));assert(!files.includes('server.py'));assert(!files.includes('node_modules'));
});
