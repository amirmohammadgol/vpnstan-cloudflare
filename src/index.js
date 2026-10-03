import { connect } from 'cloudflare:sockets';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function json(data, status=200, headers={}) {
  return new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json; charset=utf-8', ...headers}});
}
function b64(s){return btoa(unescape(encodeURIComponent(s))).replace(/=+$/,'');}
function uuidv4(){
  const a=crypto.getRandomValues(new Uint8Array(16));
  a[6]=(a[6]&15)|64; a[8]=(a[8]&63)|128;
  const h=[...a].map(x=>x.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function token(){return b64(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/[^A-Za-z0-9]/g,'').slice(0,24);}
function auth(request, env){
  const h=request.headers.get('authorization')||'';
  if(!h.startsWith('Basic ')) return false;
  try { const s=atob(h.slice(6)); const i=s.indexOf(':'); return i>=0 && s.slice(0,i)===env.ADMIN_USERNAME && s.slice(i+1)===env.ADMIN_PASSWORD; } catch { return false; }
}
function clientBase(request, client){
  const u=new URL(request.url); const host=u.host;
  const link=`vless://${client.uuid}@${host}:443?encryption=none&security=tls&type=ws&path=%2Fws%3Fid%3D${encodeURIComponent(client.token)}&host=${encodeURIComponent(host)}#${encodeURIComponent(client.name)}`;
  return link;
}
async function getClientByToken(env, t){
  return env.DB.prepare('SELECT * FROM clients WHERE token=?').bind(t).first();
}
async function getClientByUuid(env, uuid){
  return env.DB.prepare('SELECT * FROM clients WHERE uuid=?').bind(uuid).first();
}
function bytesFrom(data){return data instanceof ArrayBuffer ? data.byteLength : data instanceof Uint8Array ? data.byteLength : typeof data==='string' ? textEncoder.encode(data).byteLength : 0;}

function readVlessHeader(buf){
  const a=new Uint8Array(buf); if(a.length<24) throw new Error('short header');
  let p=0; const version=a[p++];
  const uuidBytes=a.slice(p,p+16); p+=16;
  const uuid=[...uuidBytes].map(x=>x.toString(16).padStart(2,'0')).join('');
  const uuidFmt=`${uuid.slice(0,8)}-${uuid.slice(8,12)}-${uuid.slice(12,16)}-${uuid.slice(16,20)}-${uuid.slice(20)}`;
  const addons=a[p++]; p+=addons;
  const cmd=a[p++]; if(cmd!==1) throw new Error('only TCP is supported');
  const port=(a[p++]<<8)|a[p++];
  const atyp=a[p++];
  let host='';
  if(atyp===1){ if(a.length<p+4) throw new Error('bad ipv4'); host=[a[p++],a[p++],a[p++],a[p++]].join('.'); }
  else if(atyp===2){ const n=a[p++]; if(a.length<p+n) throw new Error('bad domain'); host=textDecoder.decode(a.slice(p,p+n)); p+=n; }
  else if(atyp===3){ if(a.length<p+16) throw new Error('bad ipv6'); const parts=[]; for(let i=0;i<8;i++){parts.push(((a[p++]<<8)|a[p++]).toString(16));} host='['+parts.join(':')+']'; }
  else throw new Error('bad address type');
  return {version,uuid:uuidFmt,host,port,offset:p};
}

async function handleVless(request, env, ctx){
  if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket') return new Response('WebSocket required',{status:426});
  const url=new URL(request.url); const tokenParam=url.searchParams.get('id') || url.pathname.split('/').pop();
  const pair=new WebSocketPair(); const client=pair[0]; const server=pair[1]; server.accept();
  let socket=null, closed=false, bytes=0, dbClient=null;
  const close=()=>{if(closed)return;closed=true;try{server.close();}catch{}try{socket?.close();}catch{}};
  server.addEventListener('message', async ev=>{
    try {
      const data=ev.data instanceof ArrayBuffer ? ev.data : typeof ev.data==='string' ? textEncoder.encode(ev.data).buffer : ev.data;
      if(!socket){
        const h=readVlessHeader(data); dbClient=await getClientByToken(env, tokenParam);
        if(!dbClient || !dbClient.enabled || dbClient.uuid!==h.uuid || dbClient.expires_at<=Date.now() || dbClient.used_bytes>=dbClient.quota_bytes){close();return;}
        socket=connect({hostname:h.host.replace(/^\[|\]$/g,''),port:h.port});
        await socket.opened;
        const first=new Uint8Array(data).slice(h.offset); if(first.byteLength) await socket.writable.getWriter().write(first);
        const reader=socket.readable.getReader();
        (async()=>{try{while(true){const r=await reader.read();if(r.done)break;if(r.value){bytes+=r.value.byteLength;server.send(r.value);}}}catch{}finally{close();}})();
      } else {
        const w=socket.writable.getWriter(); const u=data instanceof ArrayBuffer?new Uint8Array(data):data; bytes+=u.byteLength; await w.write(u); w.releaseLock();
      }
    } catch { close(); }
  });
  server.addEventListener('close',close); server.addEventListener('error',close);
  const flush=async()=>{if(dbClient&&bytes>0){const n=Math.min(bytes,Math.max(0,dbClient.quota_bytes-dbClient.used_bytes)); if(n>0) await env.DB.prepare('UPDATE clients SET used_bytes=used_bytes+? WHERE id=?').bind(n,dbClient.id).run(); bytes=0;}}
  const timer=setInterval(()=>ctx.waitUntil(flush()),1000);
  const cleanup=async()=>{clearInterval(timer);await flush();close();};
  server.addEventListener('close',()=>ctx.waitUntil(cleanup()));
  return new Response(null,{status:101,webSocket:client});
}

export default {
  async fetch(request, env, ctx){
    const url=new URL(request.url);
    if(url.pathname==='/ws' || url.pathname==='/ws/') return handleVless(request,env,ctx);
    if(url.pathname==='/health') return json({ok:true, panel:env.PANEL_NAME||'vpnstan', xray:false, mode:'cloudflare-worker-vless'});
    if(url.pathname.startsWith('/sub/')){
      const t=url.pathname.slice(5); const c=await getClientByToken(env,t);
      if(!c||!c.enabled||c.expires_at<=Date.now()||c.used_bytes>=c.quota_bytes) return new Response('',{status:404});
      const body=b64(clientBase(request,c));
      return new Response(body,{headers:{'content-type':'text/plain; charset=utf-8','Profile-Update-Interval':'1','Cache-Control':'no-store'}});
    }
    if(url.pathname==='/api/login' && request.method==='POST'){
      const ok=auth(request,env); return json({ok},ok?200:401);
    }
    if(url.pathname.startsWith('/api/')){
      if(!auth(request,env)) return json({error:'unauthorized'},401,{ 'www-authenticate':'Basic realm="vpnstan"'});
      if(url.pathname==='/api/clients' && request.method==='GET'){
        const {results}=await env.DB.prepare('SELECT * FROM clients ORDER BY created_at DESC').all();
        return json({clients:results.map(c=>({...c, link:clientBase(request,c), sub:`${url.origin}/sub/${c.token}`}))});
      }
      if(url.pathname==='/api/clients' && request.method==='POST'){
        const body=await request.json(); const name=String(body.name||'Client').slice(0,60); const quota=Math.max(1,Number(body.quota_gb||50))*1073741824; const days=Math.max(1,Number(body.days||30));
        const id=crypto.randomUUID(), uuid=uuidv4(), t=token(), now=Date.now(), exp=now+days*86400000;
        await env.DB.prepare('INSERT INTO clients(id,name,uuid,token,quota_bytes,expires_at,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,name,uuid,t,quota,exp,now).run();
        const c={id,name,uuid,token:t,quota_bytes:quota,used_bytes:0,expires_at:exp,enabled:1,created_at:now};
        return json({...c,link:clientBase(request,c),sub:`${url.origin}/sub/${t}`},201);
      }
      const m=url.pathname.match(/^\/api\/clients\/([^/]+)\/(disable|enable|delete)$/); if(m){const id=m[1],action=m[2]; if(action==='delete') await env.DB.prepare('DELETE FROM clients WHERE id=?').bind(id).run(); else await env.DB.prepare('UPDATE clients SET enabled=? WHERE id=?').bind(action==='enable'?1:0,id).run(); return json({ok:true});}
      if(url.pathname==='/api/reset' && request.method==='POST'){await env.DB.prepare('UPDATE clients SET used_bytes=0').run();return json({ok:true});}
    }
    return env.ASSETS.fetch(request);
  }
};
