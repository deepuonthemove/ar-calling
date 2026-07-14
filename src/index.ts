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
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${host}/media/${callSid}" /></Connect></Response>`
  return c.text(twiml, 200, { 'Content-Type': 'text/xml' })
})

app.get('/media/:callSid', async (c) => {
  const callSid = c.req.param('callSid')
  if (!callSid) return c.text('Missing callSid', 400)
  const id = c.env.CALL_SESSION.idFromName(callSid)
  const stub = c.env.CALL_SESSION.get(id)
  return stub.fetch(c.req.raw)
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

      <!-- Trigger Call Form -->
      <div class="bg-gray-800 p-6 rounded-lg mb-6 border border-gray-700">
        <h2 class="text-lg font-bold mb-4 text-gray-200">Start a Demo Call</h2>
        <form id="call-form" class="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          <div>
            <label class="block text-xs text-gray-400 mb-1">PHONE NUMBER</label>
            <input type="text" id="phone" placeholder="+15551234567" required class="w-full bg-gray-900 border border-gray-700 rounded p-2 text-sm text-white focus:outline-none focus:border-blue-500">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">PAYER</label>
            <input type="text" id="payer" placeholder="Aetna" class="w-full bg-gray-900 border border-gray-700 rounded p-2 text-sm text-white focus:outline-none focus:border-blue-500">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">CLAIM ID</label>
            <input type="text" id="claim_id" placeholder="CLM-90210" class="w-full bg-gray-900 border border-gray-700 rounded p-2 text-sm text-white focus:outline-none focus:border-blue-500">
          </div>
          <button type="submit" id="submit-btn" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold p-2 rounded text-sm transition duration-200">
            Place Outbound Call
          </button>
        </form>
        <div id="form-message" class="mt-3 text-xs hidden"></div>
      </div>

      <div class="grid grid-cols-4 gap-4 mb-6">
        <div class="bg-gray-800 p-4 rounded-lg"><div class="text-sm text-gray-400">Calls Today</div><div id="calls-today" class="text-2xl font-bold">0</div></div>
        <div class="bg-gray-800 p-4 rounded-lg"><div class="text-sm text-gray-400">Success Rate</div><div id="success-rate" class="text-2xl font-bold">0%</div></div>
        <div class="bg-gray-800 p-4 rounded-lg"><div class="text-sm text-gray-400">Avg Duration</div><div id="avg-duration" class="text-2xl font-bold">0m</div></div>
        <div class="bg-gray-800 p-4 rounded-lg"><div class="text-sm text-gray-400">Cost Today</div><div id="cost-today" class="text-2xl font-bold">$0.00</div></div>
      </div>
      <div class="bg-gray-800 rounded-lg overflow-hidden">
        <table class="w-full text-sm"><thead class="bg-gray-700 text-gray-300"><tr>
          <th class="text-left p-3">Time</th><th class="text-left p-3">Payer</th><th class="text-left p-3">Claim ID</th>
          <th class="text-left p-3">Status</th><th class="text-left p-3">Amount</th><th class="text-left p-3">Next Action</th><th class="text-left p-3">Last Error</th><th class="text-left p-3"></th>
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
          <td class="p-3 text-gray-400">\${d.started_at ? new Date(Number(d.started_at)).toLocaleTimeString() : '-'}</td>
          <td class="p-3">\${d.payer||'-'}</td>
          <td class="p-3 font-mono">\${d.claim_id||'-'}</td>
          <td class="p-3"><span class="px-2 py-1 rounded text-xs \${d.status==='ready'||d.status==='completed'?'bg-green-900 text-green-300':d.status==='failed'?'bg-red-900 text-red-300':d.status==='disconnected'?'bg-gray-700 text-gray-300':'bg-yellow-900 text-yellow-300'}">\${d.status}</span></td>
          <td class="p-3">\${d.amount?'$'+d.amount.toFixed(2):'-'}</td>
          <td class="p-3 text-gray-400">\${d.next_action||'-'}</td>
          <td class="p-3 font-mono text-xs max-w-xs truncate" title="\${d.status==='failed'?d.last_error||'':''}">\${d.status==='failed'&&d.last_error?'<span class=\\'text-red-400\\'>'+d.last_error+'</span>':'-'}</td>
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

      document.getElementById('call-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('submit-btn');
        const msg = document.getElementById('form-message');
        const phone = document.getElementById('phone').value;
        const payer = document.getElementById('payer').value;
        const claim_id = document.getElementById('claim_id').value;

        btn.disabled = true;
        btn.textContent = 'Placing Call...';
        msg.className = 'mt-3 text-xs text-gray-400';
        msg.textContent = 'Contacting Twilio...';
        msg.classList.remove('hidden');

        try {
          const res = await fetch('/make-call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, payer, claim_id })
          });
          const data = await res.json();
          if (res.ok) {
            msg.className = 'mt-3 text-xs text-green-400';
            msg.textContent = \`Call successfully triggered! Call SID: \${data.callSid}\`;
            document.getElementById('phone').value = '';
          } else {
            msg.className = 'mt-3 text-xs text-red-400';
            msg.textContent = \`Error: \${data.error}\`;
          }
        } catch (err) {
          msg.className = 'mt-3 text-xs text-red-400';
          msg.textContent = \`Failed to connect to backend: \${err.message}\`;
        } finally {
          btn.disabled = false;
          btn.textContent = 'Place Outbound Call';
        }
      });

      async function fetchCalls() {
        try {
          const res = await fetch('/api/calls')
          if (!res.ok) return
          const calls = await res.json()
          
          rows.innerHTML = ''
          stats = { total: 0, success: 0, cost: 0 }
          
          calls.reverse().forEach(d => {
            addRow(d, d.callSid)
          })
        } catch (err) {
          console.error('Failed to fetch calls:', err)
        }
      }

      fetchCalls()
      setInterval(fetchCalls, 3000)
    </script></body></html>
  `)
})

app.get('/api/calls', async (c) => {
  const redis = Redis.fromEnv(c.env)
  const keys = await redis.keys('call:*')
  const calls = []
  for (const key of keys.slice(0, 20)) {
    const data = await redis.hgetall(key)
    calls.push({ callSid: key.replace('call:', ''), ...data })
  }
  calls.sort((a, b) => Number(b.started_at || 0) - Number(a.started_at || 0))
  return c.json(calls)
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

app.get('/api/check-secrets', (c) => {
  return c.json({
    openai: !!c.env.OPENAI_API_KEY,
    deepgram: !!c.env.DEEPGRAM_KEY,
    cartesia: !!c.env.CARTESIA_KEY,
    twilio_sid: !!c.env.TWILIO_ACCOUNT_SID,
    twilio_token: !!c.env.TWILIO_AUTH_TOKEN,
    twilio_from: !!c.env.TWILIO_FROM_NUMBER
  })
})

app.post('/make-call', async (c) => {
  const { phone, payer, claim_id } = await c.req.json()
  if (!phone) return c.json({ error: 'Phone number is required' }, 400)

  const sid = c.env.TWILIO_ACCOUNT_SID
  const token = c.env.TWILIO_AUTH_TOKEN
  const from = c.env.TWILIO_FROM_NUMBER

  if (!sid || !token || !from) {
    return c.json({ error: 'Twilio credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER) are not configured as secrets in the Worker environment.' }, 400)
  }

  const auth = btoa(`${sid}:${token}`)
  const host = new URL(c.req.url).host
  const webhookUrl = `https://${host}/voice?payer=${encodeURIComponent(payer || 'unknown')}&claim_id=${encodeURIComponent(claim_id || 'unknown')}`

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      To: phone,
      From: from,
      Url: webhookUrl
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    return c.json({ error: `Twilio API error: ${errorText}` }, 500)
  }

  const data = await response.json() as any
  return c.json({ ok: true, callSid: data.sid })
})

export default app