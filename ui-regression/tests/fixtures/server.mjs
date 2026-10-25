import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
export async function startUiFixture(){
 const body=await readFile(fileURLToPath(new URL('./index.html',import.meta.url)));let submissions=0;
 const server=http.createServer((req,res)=>{if(req.method!=='GET'&&req.method!=='HEAD'){submissions++;res.writeHead(405);res.end();return;}if(req.url==='/'){res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(body);}else{res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {origin:'http://127.0.0.1:'+server.address().port,submissions:()=>submissions,close:()=>new Promise(resolve=>server.close(resolve))};
}
