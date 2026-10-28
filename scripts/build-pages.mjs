import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const context={window:{}};
vm.runInNewContext(await fs.readFile(path.join(root,'web/config.js'),'utf8'),context);
const config={...context.window.SHARECOST_CONFIG,backend:'supabase'};
if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.supabaseUrl)||!config.publishableKey?.startsWith('sb_publishable_'))
  throw new Error('Set a Supabase project URL and publishable browser key in web/config.js.');

const out=path.join(root,'dist');
await fs.rm(out,{recursive:true,force:true});
await fs.mkdir(path.join(out,'vendor'),{recursive:true});
for(const name of ['index.html','style.css','app.js','i18n.js','backend.js'])
  await fs.copyFile(path.join(root,'web',name),path.join(out,name));
await fs.writeFile(path.join(out,'config.js'),'window.SHARECOST_CONFIG=Object.freeze('+JSON.stringify(config)+');\n');
await fs.writeFile(path.join(out,'.nojekyll'),'');
let index=await fs.readFile(path.join(out,'index.html'),'utf8');
index=index.replace('</head>',`  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${config.supabaseUrl}; base-uri 'self'; form-action 'self'">\n</head>`);
await fs.writeFile(path.join(out,'index.html'),index);
await build({stdin:{contents:"export {createClient} from '@supabase/supabase-js';",resolveDir:root},bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,outfile:path.join(out,'vendor/supabase.js'),legalComments:'eof'});
console.log('Built GitHub Pages site in dist/ using Supabase. Only public frontend assets are included.');
