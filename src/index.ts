import { Hono } from 'hono'
import { Redis } from '@upstash/redis/cloudflare'
import { html } from 'hono/html'
import type { Env, CallResult } from './types'
export { CallSession } from './do'

const app = new Hono<{ Bindings: Env }>()

app.post('/voice', async (c) => {
  const formData = await c.req.formData()
  const callSid = formData.get('CallSid') as string
  const to = formData.get('To') as string
  const redis = Redis.fromEnv(c.env)
  await redis.hset(`call:${callSid}`, {
    claim_id: c.req.query('claim_id') || 'unknown',
    payer: c.req.query('payer') || 'unknown',
    phone: to,
    status: 'dialing',
    started_at: Date.now()
  })
  const host = new URL(c.req.url).host
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${host}/media?callSid=${callSid}" /></Connect></Response>`
  return c.text(twiml, 200, { 'Content-Type': 'text/xml' })
})

app.get('/media', async (c) => {
  const callSid = c.req.query('callSid')
  if (!callSid) return c.text('Missing callSid', 400)
  const id = c.env.CALL_SESSION.idFromName(callSid)
  const stub = c.env.CALL_SESSION.get(id)
  return stub.fetch(c.req)
})

app.post('/call-result', async (c) => {
  const redis = Redis.fromEnv(c.env)
  const data = await c.req.json<CallResult>()
  await redis.hset(`call:${data.callSid}`, {...data, ended_at: Date.now(), status: 'completed' })
  await redis.publish('call-updates', JSON.stringify({ callSid: data.callSid,...data }))
  return c.json({ ok: true })
})

app.get('/dashboard', (c) => {
  return c.html(html`
<!DOCTYPE html><html><head><title>AR Voice Agent</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-900 text-gray-100 p-6"><div class="max-w-7xl mx-auto">
<h1 class="text-3xl font-bold mb-6">AR Voice Agent <span class="text-green-400 text-sm">● LIVE</span>
<a href="/export.csv" class="ml-4 px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm">Export CSV</a></h1>
<div class="grid grid-cols-4 gap-4 mb-6">
<div class="bg-gray-800 p-4 rounded-lg"><div class="text-sm text-gray-400">Calls Today</div><div id="calls" class="text-2xl font-bold">0</div></div>
<div class="bg-gray-800 p-4 rounded-lg"><div class="text-sm text-gray-400">Success Rate</div><div id="rate" class="text-2xl font-bold">0%</div></div>
<div class="bg-gray-800 p-4 rounded-lg"><div class="text-sm text-gray-400">Avg Duration</div><div id="avg" class="text-2xl font-bold">0m</div></div>
<div class="bg-gray-800 p-4 rounded-lg"><div class="text-sm text-gray-400">Cost Today</div><div id="cost" class="text-2xl font-bold">$0.00</div></div></div>
<div class="bg-gray-800 rounded-lg overflow-hidden"><table class="w-full text-sm">
<thead class="bg-gray-700"><tr><th class="p-3 text-left">Time</th><th class="p-3 text-left">Payer</th><th class="p-3 text-left">Claim ID</th><th class="p-3 text-left">Status</th><th class="p-3 text-left">Amount</th><th class="p-3 text-left">Next Action</th><th class="p-3 text-left"></th></tr></thead>
<tbody id="rows"></tbody></table></div></div>
<script>
const rows = document.getElementById('rows'); let stats = {t:0,s:0,c:0};
function addRow(d,sid){const tr=document.createElement('tr');tr.className='border-t border-gray-700';tr.id='row-'+sid;
tr.innerHTML=\`<td class="p-3 text-gray-400">\${new Date().toLocaleTimeString()}</td>
<td class="p-3">\${d.payer||'-'}</td><td class="p-3 font-mono">\${d.claim_id||'-'}</td>
<td class="p-3"><span class="px-2 py-1 rounded text-xs \${d.status==='ready'?'bg-green-900 text-green-300':d.status==='failed'?'bg-red-900 text-red-300':'bg-yellow-900 text-yellow-300'}">\${d.status}</span></td>
<td class="p-3">\${d.amount?'$'+d.amount.toFixed(2):'-'}</td><td class="p-3 text-gray-400">\${d.next_action||'-'}</td>
<td class="p-3">\${d.status==='failed'?'<button onclick="retryCall(\\''+sid+'\\')" class="px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs">Retry</button>':''}</td>\`;
rows.prepend(tr);stats.t++;if(d.status==='ready')stats.s++;stats.c+=0.02;
document.getElementById('calls').textContent=stats.t;document.getElementById('rate').textContent=Math.round(stats.s/stats.t*100)+'%';
document.getElementById('cost').textContent='$'+stats.c.toFixed(2);}
async function retryCall(sid){const b=event.target;b.textContent='Queuing...';b.disabled=true;
const r=await fetch('/retry/'+sid,{method:'POST'});b.textContent=r.ok?'Queued':'Error';}
const es=new EventSource('/stream');es.onmessage=e=>{const d=JSON.parse(e.data);addRow(d,d.callSid)};
</script></body></html>`)
})

app.get('/stream', async (c) => {
  const redis = Redis.fromEnv(c.env)
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const enc = new TextEncoder()
  redis.subscribe('call-updates').then(sub => sub.on('message', (m) => writer.write(enc.encode(`data: ${m}\n\n`))))
  const keys = await redis.keys('call:*')
  for (const key of keys.slice(0,20)) {
    const data = await redis.hgetall(key)
    if (data.status === 'completed' || data.status === 'failed') {
      writer.write(enc.encode(`data: ${JSON.stringify({callSid:key.replace('call:',''),...data})}\n\n`))
    }
  }
  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
})

app.get('/export.csv', async (c) => {
  const redis = Redis.fromEnv(c.env)
  const keys = await redis.keys('call:*')
  let csv = 'call_sid,timestamp,payer,claim_id,status,amount,next_action,duration_sec\n'
  for (const key of keys) {
    const d = await redis.hgetall(key) as Record<string,string>
    if (d.status === 'completed' || d.status === 'failed') {
      csv += `"${key.replace('call:','')}","${new Date(Number(d.ended_at||d.started_at)).toISOString()}","${d.payer||''}","${d.claim_id||''}","${d.status||''}","${d.amount||''}","${d.next_action||''}","${Math.round(Number(d.duration_ms||0)/1000)}"\n`
    }
  }
  return new Response(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="ar-calls-${new Date().toISOString().split('T')[0]}.csv"` } })
})

app.post('/retry/:callSid', async (c) => {
  const callSid = c.req.param('callSid')
  const redis = Redis.fromEnv(c.env)
  const data = await redis.hgetall(`call:${callSid}`)
  if (!data || data.status!== 'failed') return c.json({ error: 'Not found or not failed' }, 404)
  await redis.hset(`call:${callSid}`, { status: 'queued', retry_count: Number(data.retry_count||0)+1 })
  return c.json({ ok: true })
})

export default app
