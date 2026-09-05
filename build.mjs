import fs from 'node:fs';
fs.mkdirSync('dist/server',{recursive:true});
const assets={};for(const f of fs.readdirSync('static')){if(!fs.statSync('static/'+f).isFile())continue;assets['/'+f]={body:fs.readFileSync('static/'+f,'utf8'),type:f.endsWith('.html')?'text/html':f.endsWith('.css')?'text/css':f.endsWith('.js')?'application/javascript':f.endsWith('.json')?'application/json':'text/plain'}}
assets['/.well-known/agent-skills/index.json']=assets['/skills-index.json'];assets['/.well-known/agent-skills/common-room/SKILL.md']=assets['/skill.md'];
fs.writeFileSync('dist/server/assets.js','export const assets='+JSON.stringify(assets)+';');fs.copyFileSync('worker.js','dist/server/index.js');
console.log('Built Common Room worker and public assets.');
