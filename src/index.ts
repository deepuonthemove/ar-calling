import { Hono } from 'hono'
import { Redis } from '@upstash/redis/cloudflare'
import { html } from 'hono/html'
import * as XLSX from 'xlsx'
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
    account_uid: c.req.query('account_uid') || '',
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
    <html><head><title>AR Voice Agent — Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>@keyframes pulse {0%,100%{opacity:1}50%{opacity:.5}}.live{animation:pulse 2s cubic-bezier(0.4,0,0.6,1) infinite}</style></head>
    <body class="bg-gray-900 text-gray-100 p-6">
    <div class="max-w-7xl mx-auto">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-3xl font-bold">Healthcare AR Voice Agent <span class="text-green-400 text-sm live">● LIVE</span></h1>
        <div class="flex gap-2">
          <a href="/api/export-excel" class="px-3 py-2 bg-green-700 hover:bg-green-600 rounded text-sm font-bold text-white transition duration-200">Export Updated Excel</a>
          <a href="/export.csv" class="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm font-bold text-white transition duration-200">Export CSV Logs</a>
        </div>
      </div>

      <!-- Main Split Layout -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        <!-- Left 1 Column: Call Control Panel & Stats -->
        <div class="lg:col-span-1 space-y-6">
          
          <!-- Trigger Call Form -->
          <div class="bg-gray-800 p-6 rounded-lg border border-gray-700">
            <h2 class="text-lg font-bold mb-4 text-gray-200 flex justify-between">
              <span>Outbound Call Control</span>
              <span id="active-claim-badge" class="text-xs text-blue-400 font-normal">No account loaded</span>
            </h2>
            <form id="call-form" class="space-y-4">
              <input type="hidden" id="account_uid" value="">
              <div>
                <label class="block text-xs text-gray-400 mb-1">PHONE NUMBER</label>
                <input type="text" id="phone" placeholder="+15551234567" required class="w-full bg-gray-900 border border-gray-700 rounded p-2 text-sm text-white focus:outline-none focus:border-blue-500">
              </div>
              <div>
                <label class="block text-xs text-gray-400 mb-1">PAYER</label>
                <input type="text" id="payer" placeholder="Aetna" class="w-full bg-gray-900 border border-gray-700 rounded p-2 text-sm text-white focus:outline-none focus:border-blue-500">
              </div>
              <div>
                <label class="block text-xs text-gray-400 mb-1">CLAIM ID / ACCOUNT NUMBER</label>
                <input type="text" id="claim_id" placeholder="CLM-90210" class="w-full bg-gray-900 border border-gray-700 rounded p-2 text-sm text-white focus:outline-none focus:border-blue-500">
              </div>
              <button type="submit" id="submit-btn" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold p-2 rounded text-sm transition duration-200">
                Place Outbound Call
              </button>
            </form>
            <div id="form-message" class="mt-3 text-xs hidden"></div>
          </div>

          <!-- Stats Widgets -->
          <div class="grid grid-cols-2 gap-4">
            <div class="bg-gray-800 p-4 rounded-lg"><div class="text-sm text-gray-400">Calls Today</div><div id="calls-today" class="text-2xl font-bold">0</div></div>
            <div class="bg-gray-800 p-4 rounded-lg"><div class="text-sm text-gray-400">Success Rate</div><div id="success-rate" class="text-2xl font-bold">0%</div></div>
            <div class="bg-gray-800 p-4 rounded-lg"><div class="text-sm text-gray-400">Avg Duration</div><div id="avg-duration" class="text-2xl font-bold">0m</div></div>
            <div class="bg-gray-800 p-4 rounded-lg"><div class="text-sm text-gray-400">Cost Today</div><div id="cost-today" class="text-2xl font-bold">$0.00</div></div>
          </div>

          <!-- Live Calls Feed -->
          <div class="bg-gray-800 rounded-lg p-4 border border-gray-700">
            <h2 class="text-lg font-bold mb-3 text-gray-200">Live Call Feed</h2>
            <div id="call-rows" class="space-y-3 max-h-[300px] overflow-y-auto pr-1"></div>
          </div>

        </div>

        <!-- Right 2 Columns: Excel Management & Target Accounts -->
        <div class="lg:col-span-2 space-y-6">
          
          <!-- Excel Upload Widget -->
          <div class="bg-gray-800 p-6 rounded-lg border border-gray-700">
            <h2 class="text-lg font-bold mb-2 text-gray-200">Excel Calling Context List</h2>
            <p class="text-xs text-gray-400 mb-4">Upload 'Calling Accounts.xlsx' to load calling instructions, dynamic claim greetings, and track execution status.</p>
            
            <form id="upload-form" class="flex gap-4 items-center">
              <input type="file" id="excel-file" accept=".xlsx" required class="block w-full text-sm text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-gray-750 file:text-gray-200 hover:file:bg-gray-700 cursor-pointer">
              <button type="submit" id="upload-btn" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm font-bold text-white transition duration-200 shrink-0">Upload Excel</button>
            </form>
            <div id="upload-message" class="mt-3 text-xs hidden"></div>
          </div>

          <!-- Target Accounts List -->
          <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
            <div class="p-4 bg-gray-750 border-b border-gray-700 flex justify-between items-center">
              <h2 class="text-lg font-bold text-gray-200">Calling Checklist</h2>
              <span id="account-count" class="text-xs text-gray-400">0 Accounts Loaded</span>
            </div>
            <div class="overflow-x-auto max-h-[500px] overflow-y-auto">
              <table class="w-full text-sm">
                <thead class="bg-gray-700 text-gray-300 sticky top-0">
                  <tr>
                    <th class="text-left p-3">Patient Name</th>
                    <th class="text-left p-3">Payer</th>
                    <th class="text-left p-3">DOS</th>
                    <th class="text-left p-3">Billed</th>
                    <th class="text-left p-3">Objective (AR Final Comments)</th>
                    <th class="text-left p-3">Outcome Comments</th>
                    <th class="text-left p-3">Status</th>
                    <th class="text-left p-3">Action</th>
                  </tr>
                </thead>
                <tbody id="account-rows" class="divide-y divide-gray-700">
                  <tr><td colspan="8" class="p-6 text-center text-gray-500">No accounts loaded. Upload an Excel file to get started.</td></tr>
                </tbody>
              </table>
            </div>
          </div>

        </div>

      </div>
    </div>

    <script>
      const callRows = document.getElementById('call-rows')
      const accountRows = document.getElementById('account-rows')
      let stats = { total: 0, success: 0, cost: 0 }

      function addCallRow(d, callSid) {
        const div = document.createElement('div')
        div.className = 'p-3 bg-gray-900 rounded border border-gray-750 hover:border-gray-700 transition'
        div.id = 'call-row-'+callSid
        
        const timeStr = d.started_at ? new Date(Number(d.started_at)).toLocaleTimeString() : '-'
        const statusBadgeColor = d.status==='ready'||d.status==='completed'?'bg-green-900 text-green-300':d.status==='failed'?'bg-red-900 text-red-300':d.status==='disconnected'?'bg-gray-700 text-gray-300':'bg-yellow-900 text-yellow-300'
        
        div.innerHTML = \`
          <div class="flex justify-between items-center mb-1">
            <span class="font-bold text-xs text-white">\${d.payer||'Unknown Payer'}</span>
            <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold \${statusBadgeColor}">\${d.status}</span>
          </div>
          <div class="text-[11px] text-gray-400 space-y-0.5">
            <div><span class="text-gray-500">Claim ID:</span> \${d.claim_id||'-'}</div>
            <div><span class="text-gray-500">Time:</span> \${timeStr}</div>
            \${d.amount ? \`<div><span class="text-gray-500">Billed:</span> $\${Number(d.amount).toFixed(2)}</div>\` : ''}
            \${d.next_action ? \`<div><span class="text-gray-500">Action:</span> \${d.next_action}</div>\` : ''}
            \${d.status==='failed'&&d.last_error ? \`<div class="text-red-400 font-mono text-[10px] break-words mt-1">Error: \${d.last_error}</div>\` : ''}
          </div>
        \`
        callRows.prepend(div)
        
        stats.total++; if(d.status==='ready'||d.status==='completed') stats.success++; stats.cost+=0.02
        document.getElementById('calls-today').textContent = stats.total
        document.getElementById('success-rate').textContent = Math.round(stats.success/stats.total*100)+'%'
        document.getElementById('cost-today').textContent = '$'+stats.cost.toFixed(2)
      }

      async function selectAccount(uid, patientName, payer, claimId) {
        document.getElementById('account_uid').value = uid
        document.getElementById('payer').value = payer || ''
        document.getElementById('claim_id').value = claimId || ''
        document.getElementById('active-claim-badge').textContent = 'Account Loaded: ' + patientName
        
        // Highlight selected row
        document.querySelectorAll('#account-rows tr').forEach(r => r.classList.remove('bg-blue-900/20', 'border-blue-800'))
        const row = document.getElementById('account-row-' + uid)
        if (row) {
          row.classList.add('bg-blue-900/20', 'border-blue-800')
        }
      }

      async function uploadExcel(e) {
        e.preventDefault()
        const fileInput = document.getElementById('excel-file')
        if (fileInput.files.length === 0) return

        const btn = document.getElementById('upload-btn')
        const msg = document.getElementById('upload-message')
        btn.disabled = true
        btn.textContent = 'Uploading...'
        msg.className = 'mt-3 text-xs text-gray-400'
        msg.textContent = 'Parsing workbook on Cloudflare Workers...'
        msg.classList.remove('hidden')

        const formData = new FormData()
        formData.append('file', fileInput.files[0])

        try {
          const res = await fetch('/api/upload-excel', {
            method: 'POST',
            body: formData
          })
          const data = await res.json()
          if (res.ok) {
            msg.className = 'mt-3 text-xs text-green-400'
            msg.textContent = \`Excel successfully parsed! Loaded \${data.count} accounts.\`
            fileInput.value = ''
            fetchAccounts()
          } else {
            msg.className = 'mt-3 text-xs text-red-400'
            msg.textContent = 'Upload failed: ' + (data.error || 'Unknown error')
          }
        } catch (err) {
          msg.className = 'mt-3 text-xs text-red-400'
          msg.textContent = 'Connection error: ' + err.message
        } finally {
          btn.disabled = false
          btn.textContent = 'Upload Excel'
        }
      }

      async function fetchAccounts() {
        try {
          const res = await fetch('/api/accounts')
          if (!res.ok) return
          const accounts = await res.json()
          
          document.getElementById('account-count').textContent = accounts.length + ' Accounts Loaded'
          
          if (accounts.length === 0) {
            accountRows.innerHTML = '<tr><td colspan="8" class="p-6 text-center text-gray-500">No accounts loaded. Upload an Excel file to get started.</td></tr>'
            return
          }

          accountRows.innerHTML = ''
          accounts.forEach(acc => {
            const tr = document.createElement('tr')
            tr.id = 'account-row-' + acc.UID
            tr.className = 'border-t border-gray-750 hover:bg-gray-750 transition duration-150'
            
            const payer = acc['Responsible Payer'] || acc['payer'] || ''
            const claimId = acc['Account Number'] || acc['claim_id'] || ''
            const status = acc['Call Status'] || 'Pending'
            
            const statusBadgeColor = status === 'Calls Done' || status === 'completed'
              ? 'bg-green-950 text-green-300'
              : status === 'Disconnected' || status === 'Failed'
              ? 'bg-red-950 text-red-300'
              : 'bg-gray-700 text-gray-300'

            tr.innerHTML = \`
              <td class="p-3 font-semibold text-white">\${acc['Patient Name'] || '-'}</td>
              <td class="p-3 text-gray-300">\${payer}</td>
              <td class="p-3 text-gray-400">\${acc['DOS'] ? new Date(acc['DOS']).toLocaleDateString() : '-'}</td>
              <td class="p-3">\${acc['Billed Amount'] ? '$'+Number(acc['Billed Amount']).toFixed(2) : '-'}</td>
              <td class="p-3 text-gray-400 text-xs max-w-xs truncate" title="\${acc['AR Final Comments'] || ''}">\${acc['AR Final Comments'] || '-'}</td>
              <td class="p-3 text-gray-300 text-xs max-w-xs truncate" title="\${acc['Call Comments'] || ''}">\${acc['Call Comments'] || '-'}</td>
              <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] font-bold \${statusBadgeColor}">\${status}</span></td>
              <td class="p-3">
                <button onclick="selectAccount('\${acc.UID}', '\${acc['Patient Name']?.replace(/'/g, "\\\\'")}', '\${payer.replace(/'/g, "\\\\'")}', '\${claimId}')" class="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 hover:scale-105 active:scale-95 rounded text-xs text-white font-bold transition duration-150">
                  Load Context
                </button>
              </td>
            \`
            accountRows.appendChild(tr)
          })
        }

      async function fetchCalls() {
        try {
          const res = await fetch('/api/calls')
          if (!res.ok) return
          const calls = await res.json()
          
          callRows.innerHTML = ''
          stats = { total: 0, success: 0, cost: 0 }
          
          calls.forEach(d => {
            addCallRow(d, d.callSid)
          })
          
          // Re-fetch accounts too on call updates to display comments instantly
          fetchAccounts()
        } catch (err) {
          console.error('Failed to fetch calls:', err)
        }
      }

      document.getElementById('upload-form').addEventListener('submit', uploadExcel)
      
      // Init
      fetchAccounts()
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
  const { phone, payer, claim_id, account_uid } = await c.req.json()
  if (!phone) return c.json({ error: 'Phone number is required' }, 400)

  const sid = c.env.TWILIO_ACCOUNT_SID
  const token = c.env.TWILIO_AUTH_TOKEN
  const from = c.env.TWILIO_FROM_NUMBER

  if (!sid || !token || !from) {
    return c.json({ error: 'Twilio credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER) are not configured as secrets in the Worker environment.' }, 400)
  }

  const auth = btoa(`${sid}:${token}`)
  const host = new URL(c.req.url).host
  const webhookUrl = `https://${host}/voice?payer=${encodeURIComponent(payer || 'unknown')}&claim_id=${encodeURIComponent(claim_id || 'unknown')}&account_uid=${encodeURIComponent(account_uid || '')}`

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

app.post('/api/upload-excel', async (c) => {
  try {
    const body = await c.req.parseBody()
    const file = body['file']
    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No file uploaded' }, 400)
    }

    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) return c.json({ error: 'Workbook is empty' }, 400)
    
    const sheet = workbook.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json(sheet) as any[]
    if (rows.length === 0) return c.json({ error: 'Sheet is empty' }, 400)

    // Parse and capture headers
    const range = XLSX.utils.decode_range(sheet['!ref'] || '')
    const headers = []
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: col })]
      if (cell && cell.v) {
        headers.push(cell.v)
      }
    }

    const redis = Redis.fromEnv(c.env)
    
    // Clear old accounts list if any
    const oldUids = await redis.get('accounts-list') as string[]
    if (oldUids && Array.isArray(oldUids)) {
      try {
        for (const o of oldUids) {
          await redis.del(`account:${o}`)
        }
      } catch (e) {}
    }

    const uids = []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      let uid = row.UID || row.uid
      if (!uid) {
        uid = `KS-PC-${i}-${Date.now()}`
        row.UID = uid
      }
      uids.push(uid)

      const formattedRow: Record<string, string> = {}
      for (const [k, v] of Object.entries(row)) {
        if (v instanceof Date) {
          formattedRow[k] = v.toISOString()
        } else if (v !== null && v !== undefined) {
          formattedRow[k] = String(v)
        }
      }
      
      if (!formattedRow['Call Status']) {
        formattedRow['Call Status'] = 'Pending'
      }

      await redis.hset(`account:${uid}`, formattedRow)
    }

    await redis.set('accounts-headers', headers)
    await redis.set('accounts-list', uids)

    return c.json({ ok: true, count: rows.length })
  } catch (err: any) {
    console.error('Failed to parse excel:', err)
    return c.json({ error: `Parsing error: ${err.message || err}` }, 500)
  }
})

app.get('/api/accounts', async (c) => {
  try {
    const redis = Redis.fromEnv(c.env)
    const uids = await redis.get('accounts-list') as string[]
    if (!uids || !Array.isArray(uids)) return c.json([])

    const accounts = []
    for (const uid of uids) {
      const row = await redis.hgetall(`account:${uid}`)
      if (row) {
        accounts.push({ UID: uid, ...row })
      }
    }
    return c.json(accounts)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.get('/api/export-excel', async (c) => {
  try {
    const redis = Redis.fromEnv(c.env)
    const uids = await redis.get('accounts-list') as string[]
    if (!uids || !Array.isArray(uids)) return c.text('No accounts to export', 404)

    const headers = await redis.get('accounts-headers') as string[] || []

    const rows = []
    for (const uid of uids) {
      const row = await redis.hgetall(`account:${uid}`)
      if (row) {
        rows.push(row)
      }
    }

    const formattedRows = rows.map(row => {
      const formatted: Record<string, any> = {}
      for (const h of headers) {
        formatted[h] = row[h] !== undefined && row[h] !== null ? row[h] : ''
      }
      return formatted
    })

    const worksheet = XLSX.utils.json_to_sheet(formattedRows, { header: headers })
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')

    const outBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })

    return new Response(outBuffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="Calling_Accounts_Updated.xlsx"'
      }
    })
  } catch (err: any) {
    return c.text(`Export error: ${err.message}`, 500)
  }
})

export default app