import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
const root=resolve('web');
createServer(async(req,res)=>{
  const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname.replace(/\/$/,'/demo.html'));
  if(!path.startsWith(root+'/')){res.writeHead(403).end();return;}
  try{const data=await readFile(path);res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css'})[extname(path)]||'application/octet-stream');res.end(data);}
  catch{res.writeHead(404).end();}
}).listen(8766,'127.0.0.1');
