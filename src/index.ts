import { Hono } from 'hono'
import { Redis } from '@upstash/redis/cloudflare'
import { html } from 'hono/html'
import type { Env } from './types'
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
  const data = await c.req.json()
  await redis.hset(`call:${data.callSid}`, { ...data, ended_at: Date.now(), status: 'completed' })
  await redis.publish('call-updates', JSON.stringify({ callSid: data.callSid, ...data }))
  return c.json({ ok: true })
})

app.get('/dashboard', (c) => {
  return c.html(html`
    <!DOCTYPE html>
    <html><head><title>AR Voice Agent — Live Calls</title><script src="https://cdn.tailwindcss.com"></script>
    <style>@keyframes pulse {0%,100%{opacity:1}50%{opacity:.5}}.live{animation:pulse 2s cubic-bezier(0.4,0,0.6,1) infinite}</style></head>
    <body class="bg-gray-900 text-gray-100 p-6">
    <div class="max-w-7xl mx-auto">
      <h1 class="text-3xl font-bold mb-6">Healthcare AR Voice Agent <span class="text-green-400 text-sm live">● LIVE</span>
        <a href="/export.csv" class="ml-4 px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm">Export CSV</a>
      </h1>
      <div class="grid grid-cols-4 gap-4 mb-6">
        <div class="bg-gray-800 p-4 rounded-lg"><div class="text-sm text-gray-400">Calls Today</div><div id="calls-today" class="text-2xl font-bold">0</div></div>
        <div class="bg-gray-800 p-4 rounded-lg"><div class="text-sm text-gray-400">Success Rate</div><div id="success-rate" class="text-2xl font-bold">0%</div></div>
        <div class="bg-gray-800 p-4 rounded-lg"><div class="text-sm text-gray-400">Avg Duration</div><div id="avg-duration" class="text-2xl font-bold">0m</div></div>
        <div class="bg-gray-800 p-4 rounded-lg"><div class="text-sm text-gray-400">Cost Today</div><div id="cost-today" class="text-2xl font-bold">$0.00</div></div>
      </div>
      <div class="bg-gray-800 rounded-lg overflow-hidden">
        <table class="w-full text-sm"><thead class="bg-gray-700 text-gray-300"><tr>
          <th class="text-left p-3">Time</th><th class="text-left p-3">Payer</th><th class="text-left p-3">Claim ID</th>
          <th class="text-left p-3">Status</th><th class="text-left p-3">Amount</th><th class="text-left p-3">Next Action</th><th class="text-left p-3"></th>
        </tr></thead><tbody id="call-rows"></tbody></table>
      </div>
    </div>
    <script>
      const rows = document.getElementById('call-rows')
      let stats = { total: 0, success: 0, cost: 0 }
      function addRow(d, callSid) {
        const tr = document.createElement('tr')
        tr.className = 'border-t border-gray-700 hover:bg-gray-750'
        tr.id = 'row-'+callSid
        tr.innerHTML = \`
          <td class="p-3 text-gray-400">\${new Date().toLocaleTimeString()}</td>
          <td class="p-3">\${d.payer||'-'}</td>
          <td class="p-3 font-mono">\${d.claim_id||'-'}</td>
          <td class="p-3"><span class="px-2 py-1 rounded text-xs \${d.status==='ready'?'bg-green-900 text-green-300':d.status==='failed'?'bg-red-900 text-red-300':'bg-yellow-900 text-yellow-300'}">\${d.status}</span></td>
          <td class="p-3">\${d.amount?'$'+d.amount.toFixed(2):'-'}</td>
          <td class="p-3 text-gray-400">\${d.next_action||'-'}</td>
          <td class="p-3">\${d.status==='failed'?'<button onclick="retryCall(\\''+callSid+'\\')" class="px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs">Retry</button>':''}</td>\`
        rows.prepend(tr)
        stats.total++; if(d.status==='ready') stats.success++; stats.cost+=0.02
        document.getElementById('calls-today').textContent=stats.total
        document.getElementById('success-rate').textContent=Math.round(stats.success/stats.total*100)+'%'
        document.getElementById('cost-today').textContent='$'+stats.cost.toFixed(2)
      }
      async function retryCall(callSid) {
        const btn=event.target; btn.textContent='Queuing...'; btn.disabled=true
        const res=await fetch('/retry/'+callSid,{method:'POST'})
        btn.textContent=res.ok?'Queued':'Error'
        if(res.ok) document.getElementById('row-'+callSid).classList.add('opacity-50')
      }
      const es=new EventSource('/stream')
      es.onmessage=(e)=>{const d=JSON.parse(e.data); addRow(d,d.callSid)}
    </script></body></html>
  `)
})

app.get('/stream', async (c) => {
  const redis = Redis.fromEnv(c.env)
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  const sub = redis.subscribe('call-updates')
  sub.on('message', (msg) => writer.write(encoder.encode(`data: ${msg}\n\n`)))
  c.header('Content-Type', 'text/event-stream')
  const keys = await redis.keys('call:*')
  for (const key of keys.slice(0, 20)) {
    const data = await redis.hgetall(key)
    if (data.status === 'completed' || data.status === 'failed') {
      writer.write(encoder.encode(`data: ${JSON.stringify({ callSid: key.replace('call:', ''), ...data })}\n\n`))
    }
  }
  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
})

app.get('/export.csv', async (c) => {
  const redis = Redis.fromEnv(c.env)
  const keys = await redis.keys('call:*')
  let csv = 'call_sid,timestamp,payer,claim_id,status,amount,next_action,duration_sec\n'
  for (const key of keys) {
    const d = await redis.hgetall(key) as Record<string, string>
    if (d.status === 'completed' || d.status === 'failed') {
      const row = [key.replace('call:', ''), new Date(Number(d.ended_at || d.started_at)).toISOString(), d.payer || '', d.claim_id || '', d.status || '', d.amount || '', d.next_action || '', Math.round(Number(d.duration_ms || 0) / 1000)]
        .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
      csv += row + '\n'
    }
  }
  return new Response(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="ar-calls-${new Date().toISOString().split('T')[0]}.csv"` } })
})

app.post('/retry/:callSid', async (c) => {
  const callSid = c.req.param('callSid')
  const redis = Redis.fromEnv(c.env)
  const data = await redis.hgetall(`call:${callSid}`)
  if (!data || data.status !== 'failed') return c.json({ error: 'Not found or not failed' }, 404)
  await redis.hset(`call:${callSid}`, { status: 'queued', retry_count: Number(data.retry_count || 0) + 1, started_at: Date.now() })
  return c.json({ ok: true })
})

export default app