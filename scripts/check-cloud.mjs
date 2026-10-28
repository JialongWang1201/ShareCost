import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createClient} from '@supabase/supabase-js';

const context={window:{}};
vm.runInNewContext(await fs.readFile(new URL('../web/config.js',import.meta.url),'utf8'),context);
const config=context.window.SHARECOST_CONFIG;
const response=await fetch(config.supabaseUrl+'/auth/v1/settings',{headers:{apikey:config.publishableKey},signal:AbortSignal.timeout(15000)});
if(!response.ok)throw new Error('Project URL or publishable key was rejected: '+response.status);
const settings=await response.json();
console.log('Project URL and public key match. Email signup:',!!settings.external?.email,'Email confirmation:',!settings.mailer_autoconfirm);
const client=createClient(config.supabaseUrl,config.publishableKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const {data,error}=await client.rpc('sharecost_api',{p_path:'/books',p_data:null});
if(error?.code==='PGRST202'){
  console.log('Database setup pending: run supabase/migrations/202610280001_sharecost.sql in the Supabase SQL Editor.');
  process.exitCode=2;
}else if(error?.code==='42501'){
  console.log('Ledger RPC exists and correctly denies anonymous access.');
}else if(data?.status===401){
  console.log('The ledger RPC rejects unauthenticated users. Verify its EXECUTE grants match the migration.');
  process.exitCode=2;
}else{
  throw new Error('Cloud setup needs inspection: '+JSON.stringify({code:error?.code,message:error?.message,status:data?.status}));
}
