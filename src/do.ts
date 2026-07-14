import { Buffer } from 'node:buffer'
import { Redis } from '@upstash/redis/cloudflare'
import OpenAI from 'openai'
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk'
import type { Env } from './types'

export class CallSession {
  state: DurableObjectState
  env: Env
  sessions: Set<WebSocket>
  redis: Redis

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
    this.sessions = new Set()
    this.redis = Redis.fromEnv(this.env)
  }

  async fetch(request: Request) {
    const url = new URL(request.url)

    if (url.pathname === '/subscribe') {
      const { 0: client, 1: server } = new WebSocketPair()
      server.accept()
      this.sessions.add(server)
      server.addEventListener('close', () => this.sessions.delete(server))
      return new Response(null, { status: 101, webSocket: client })
    }

    if (url.pathname === '/publish') {
      const data = await request.text()
      this.sessions.forEach(ws => ws.send(data))
      return new Response('ok')
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 400 })
    }

    const { 0: client, 1: server } = new WebSocketPair()
    this.handleSession(server, request)
    return new Response(null, { status: 101, webSocket: client })
  }

  async handleSession(ws: WebSocket, req: Request) {
    ws.accept()
    console.log('DO: WebSocket connected', req.url.toString())
    const url = new URL(req.url.toString())
    let callSid = url.searchParams.get('callSid')
    if (!callSid) {
      const parts = url.pathname.split('/')
      if (parts.includes('media')) {
        callSid = parts[parts.indexOf('media') + 1] || null
      }
    }
    console.log('DO: callSid =', callSid)
    if (!callSid) {
      ws.close(1008, 'Missing callSid')
      return
    }

    const redis = this.redis
    const callData: any = await redis.hgetall(`call:${callSid}`)
    const accountUid = callData?.account_uid || ''

    let firstGreeting = '[Call connected]'
    let accountData: any = null
    if (accountUid) {
      accountData = await redis.hgetall(`account:${accountUid}`)
      if (accountData) {
        firstGreeting = `Hello, thank you. I am calling to check the status of a claim for patient ${accountData['Patient Name'] || 'unknown'}, Date of Service ${accountData['DOS'] || 'unknown'}, with billed amount $${accountData['Billed Amount'] || 'unknown'}.`
      }
    }

    let streamSid = ''
    let isBotSpeaking = false
    let silenceMs = 0
    let isCallEnded = false

    const silenceTimer = setInterval(() => {
      silenceMs += 100
      if (silenceMs > 19 * 60 * 1000) {
        clearInterval(silenceTimer)
        ws.close(1011, 'Max silence reached')
      }
    }, 100)

    const closeCall = async (status: string) => {
      isCallEnded = true
      clearInterval(silenceTimer)
      if (dgConnection) {
        try { dgConnection.finish() } catch (e) {}
      }
      if (cartesiaWs) {
        try { cartesiaWs.close() } catch (e) {}
      }
      try {
        ws.close()
      } catch (e) {}

      try {
        const current = await redis.hget(`call:${callSid}`, 'status')
        if (current !== 'completed' && current !== 'ready' && current !== 'failed' && current !== 'disconnected') {
          const startTime = await redis.hget(`call:${callSid}`, 'started_at') as number
          const result = {
            status,
            ended_at: Date.now(),
            duration_ms: startTime ? (Date.now() - startTime) : 0
          }
          await redis.hset(`call:${callSid}`, result)
          await redis.publish('call-updates', JSON.stringify({ callSid, ...result }))

          // Update the Excel account row in Redis on early close
          if (accountUid) {
            const todayStr = new Date().toLocaleDateString('en-US')
            const accountUpdate = {
              'Call Comments': status === 'disconnected' ? 'Call disconnected' : 'Call failed during dialing',
              'Call Date': todayStr,
              'Call Status': status === 'disconnected' ? 'Disconnected' : 'Failed'
            }
            await redis.hset(`account:${accountUid}`, accountUpdate)
          }
        }
      } catch (err) {
        console.error('DO: Error in closeCall cleanup:', err)
      }
    }

    let openai: OpenAI
    let deepgram: ReturnType<typeof createClient>
    let dgConnection: any
    try {
      openai = new OpenAI({ apiKey: this.env.OPENAI_API_KEY })
      deepgram = createClient(this.env.DEEPGRAM_KEY)
    } catch (err: any) {
      console.error('DO: Fatal initialization error:', err)
      await redis.hset(`call:${callSid}`, { last_error: `Init error: ${err.message || err}` })
      ws.close(1011, `DO init error: ${err.message || err}`)
      return
    }

    let isDgOpen = false
    const dgQueue: Buffer[] = []

    const openDeepgram = () => {
      if (isCallEnded) return
      try {
        console.log('DO: Connecting to Deepgram...')
        dgConnection = deepgram.listen.live({
          model: 'nova-2-medical',
          language: 'en-US',
          smart_format: true,
          interim_results: true,
          endpointing: 300,
          utterance_end_ms: 1000,
          vad_events: true,
          // Twilio streams mulaw audio at 8kHz mono - must match exactly
          encoding: 'mulaw',
          sample_rate: 8000,
          channels: 1
        })

        dgConnection.on(LiveTranscriptionEvents.Open, () => {
          console.log('DO: Deepgram connection opened')
          isDgOpen = true
          while (dgQueue.length > 0) {
            const chunk = dgQueue.shift()
            if (chunk) dgConnection.send(chunk)
          }
        })

        dgConnection.on(LiveTranscriptionEvents.Transcript, async (data: any) => {
          const text = data.channel.alternatives[0].transcript
          if (text && data.is_final) {
            silenceMs = 0
            await runLLM(text)
          }
        })

        dgConnection.on(LiveTranscriptionEvents.SpeechStarted, () => {
          if (isBotSpeaking) {
            ws.send(JSON.stringify({ event: 'clear', streamSid }))
            if (isCartesiaOpen && cartesiaWs) {
              cartesiaWs.send(JSON.stringify({ context_id: streamSid, type: 'flush' }))
            }
            isFirstCartesiaChunk = true
            isBotSpeaking = false
          }
        })

        dgConnection.on(LiveTranscriptionEvents.VadEvents, (evt: any) => {
          if (evt.label === 'speech' && silenceMs > 3000) runLLM('[Hold music detected]')
        })

        dgConnection.on(LiveTranscriptionEvents.Error, async (err: any) => {
          console.error('DO: Deepgram error:', err)
          await redis.hset(`call:${callSid}`, { last_error: `Deepgram error: ${err.message || err}` })
          ws.send(JSON.stringify({ event: 'clear', streamSid }))
          runLLM('[System error, please repeat]')
        })

        dgConnection.on(LiveTranscriptionEvents.Close, () => {
          console.log('DO: Deepgram connection closed')
          isDgOpen = false
          if (!isCallEnded) {
            console.log('DO: Deepgram closed unexpectedly, reconnecting in 1s...')
            setTimeout(openDeepgram, 1000)
          }
        })
      } catch (err: any) {
        console.error('DO: Error opening Deepgram:', err)
        if (!isCallEnded) {
          setTimeout(openDeepgram, 1000)
        }
      }
    }

    openDeepgram()

    let cartesiaWs: WebSocket | null = null
    let isCartesiaOpen = false
    const cartesiaQueue: string[] = []
    let isFirstCartesiaChunk = true

    const openCartesia = async () => {
      isFirstCartesiaChunk = true
      if (isCallEnded) return
      try {
        console.log('DO: Connecting to Cartesia...')
        const res = await fetch("https://api.cartesia.ai/tts/websocket?cartesia_version=2024-06-10", {
          headers: {
            "Upgrade": "websocket",
            "X-API-Key": this.env.CARTESIA_KEY
          }
        })
        const socket = res.webSocket
        if (!socket) {
          console.error("DO: Failed to connect to Cartesia (no socket returned)")
          await redis.hset(`call:${callSid}`, { last_error: 'Cartesia: no socket returned on connect' })
          if (!isCallEnded) {
            console.log('DO: Cartesia failed to connect, retrying in 1s...')
            setTimeout(openCartesia, 1000)
          }
          return
        }
        socket.accept()
        cartesiaWs = socket
        isCartesiaOpen = true
        console.log('DO: Cartesia connection opened')

        // Drain any queued TTS payloads
        while (cartesiaQueue.length > 0) {
          const payload = cartesiaQueue.shift()
          if (payload) cartesiaWs.send(payload)
        }

        cartesiaWs.addEventListener('message', async (msg) => {
          try {
            const data = JSON.parse(msg.data as string)
            if (data.type === 'chunk' && data.data) {
              ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: data.data } }))
            } else if (data.type === 'done') {
              isBotSpeaking = false
            } else if (data.type === 'error') {
              console.error('DO: Cartesia API error:', data)
              await redis.hset(`call:${callSid}`, { last_error: `Cartesia API error: ${JSON.stringify(data)}` })
            }
          } catch (e: any) {
            console.error('DO: Error parsing Cartesia message:', e)
          }
        })

        cartesiaWs.addEventListener('error', async (err: any) => {
          console.error('DO: Cartesia WebSocket error:', err)
          await redis.hset(`call:${callSid}`, { last_error: `Cartesia WS error: ${err.message || err}` })
        })

        cartesiaWs.addEventListener('close', () => {
          console.log('DO: Cartesia WebSocket closed')
          isCartesiaOpen = false
          if (!isCallEnded) {
            console.log('DO: Cartesia closed unexpectedly, reopening in 1s...')
            setTimeout(openCartesia, 1000)
          }
        })
      } catch (err: any) {
        console.error("DO: Exception opening Cartesia:", err)
        await redis.hset(`call:${callSid}`, { last_error: `Cartesia connection error: ${err.message || err}` })
        if (!isCallEnded) {
          console.log('DO: Cartesia threw error on open, retrying in 1s...')
          setTimeout(openCartesia, 1000)
        }
      }
    }

    // Cartesia WebSocket API: first chunk must include full voice/model/format config;
    // subsequent chunks only need context_id, transcript, continue.
    const sendToCartesia = (transcript: string, isContinue: boolean) => {
      let payload: any
      if (isFirstCartesiaChunk) {
        isFirstCartesiaChunk = false
        payload = {
          model_id: 'sonic-2',
          voice: { mode: 'id', id: this.env.CARTESIA_VOICE_ID },
          output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
          language: 'en',
          context_id: streamSid,
          transcript,
          continue: isContinue
        }
      } else {
        payload = { context_id: streamSid, transcript, continue: isContinue }
      }
      const payloadStr = JSON.stringify(payload)
      if (isCartesiaOpen && cartesiaWs) {
        cartesiaWs.send(payloadStr)
      } else {
        cartesiaQueue.push(payloadStr)
      }
    }

    let systemPrompt = `You are an AR specialist calling insurance payers.
Rules:
1. If you hear a menu like "Press 1 for claims", output ONLY this exact text: [DTMF:1] - nothing else.
2. If silence >3s and you hear music/hold tones, output ONLY: [WAITING]
3. When the call is resolved, output ONLY: [END:completed:PrayerName:ClaimID:Amount:NextAction] filling in the real values.
4. For normal conversation, respond naturally in under 15 words.
5. Never say things like "pressing 1" or describe your actions - just do them with the markers above.`

    if (accountData) {
      systemPrompt = `You are an AR specialist calling insurance payers to check the status of a specific medical claim.
Here is the context for this call:
- Patient Name: ${accountData['Patient Name'] || 'unknown'}
- Date of Service (DOS): ${accountData['DOS'] || 'unknown'}
- Billed Amount: $${accountData['Billed Amount'] || 'unknown'}
- Procedure Code (CPT): ${accountData['CPT'] || 'unknown'}
- Account Number: ${accountData['Account Number'] || 'unknown'}
- Responsible Payer: ${accountData['Responsible Payer'] || 'unknown'}
- Call Objective / Background: ${accountData['AR Final Comments'] || 'Call and check status of this claim.'}

Rules:
1. If you hear a menu like "Press 1 for claims", output ONLY this exact text: [DTMF:1] - nothing else.
2. If silence >3s and you hear music/hold tones, output ONLY: [WAITING]
3. When the call is resolved, output ONLY: [END:completed:${accountData['Responsible Payer'] || 'unknown'}:${accountData['Account Number'] || 'unknown'}:${accountData['Billed Amount'] || '0'}:Call Completed] filling in the real values.
4. For normal conversation, respond naturally in under 15 words. Keep the focus entirely on resolving the objective.
5. Never say things like "pressing 1" or describe your actions - just do them with the markers above.`
    }

    let llmMessages: any[] = [
      { role: 'system', content: systemPrompt }
    ]

    const runLLM = async (userText: string) => {
      console.log('DO: runLLM called with userText:', userText)
      if (isBotSpeaking) {
        ws.send(JSON.stringify({ event: 'clear', streamSid }))
        // Flush Cartesia and reset first-chunk flag so next message includes full config
        if (isCartesiaOpen && cartesiaWs) {
          cartesiaWs.send(JSON.stringify({ context_id: streamSid, type: 'flush' }))
        }
        isFirstCartesiaChunk = true
        isBotSpeaking = false
      }
      // Always reset so each bot turn sends full Cartesia voice config
      isFirstCartesiaChunk = true

      llmMessages.push({ role: 'user', content: userText })

      let useCF = true
      const model = this.env.LLM_MODEL || "gpt-5-nano"
      
      // If LLM_MODEL is explicitly set to an OpenAI model and is NOT a CF model, run OpenAI first
      if (model.startsWith('gpt-') && !model.startsWith('@cf/')) {
        useCF = false
      }

      // 1. Try Cloudflare Workers AI first (if useCF is true)
      if (useCF) {
        try {
          if (!this.env.AI) {
            throw new Error('env.AI binding is missing in wrangler.toml')
          }
          const cfModel = model.startsWith('@cf/') ? model : '@cf/meta/llama-3.1-8b-instruct-fp8'
          console.log('DO: Requesting Cloudflare Workers AI with model:', cfModel)
          
          const cfStream = await this.env.AI.run(cfModel, {
            messages: llmMessages,
            stream: true
          })

          const reader = cfStream.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let botText = ''

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''
            for (const line of lines) {
              const trimmed = line.trim()
              if (trimmed.startsWith('data: ')) {
                const dataStr = trimmed.slice(6).trim()
                if (dataStr === '[DONE]') continue
                try {
                  const data = JSON.parse(dataStr)
                  const token = data.response || data.text
                  if (token) {
                    botText += token
                  }
                } catch (jsonErr) {
                  // Ignore JSON parse errors on partial chunks
                }
              }
            }
          }
          console.log('DO: Workers AI stream completed. botText:', botText)
          if (botText.trim()) {
            llmMessages.push({ role: 'assistant', content: botText })
            await redis.hset(`call:${callSid}`, { last_llm_response: botText })

            // 1. Check for DTMF
            const dtmfMatch = botText.match(/(?:\[?DTMF\s*[:=]\s*(\d+)\]?)|(?:press_dtmf\s*\(\s*digit\s*=\s*["']?(\d+)["']?\s*\))/i)
            const dtmfDigit = dtmfMatch ? (dtmfMatch[1] || dtmfMatch[2]) : null

            // 2. Check for End Call
            const endMatch = botText.match(/\[?END\s*[:=]\s*([^\]\n]+)\]?/i)
            const callEndedMatch = botText.match(/\[?CALL\s+ENDED\]?/i) || botText.match(/end_call/i)
            const isEnd = !!(endMatch || callEndedMatch)

            // 3. Check for WAITING
            const isWaiting = /\[?WAITING\]?/i.test(botText) || /wait_for_human/i.test(botText)

            // 4. Strip any markers so we don't speak them
            const spokenText = botText
              .replace(/(?:\[?DTMF\s*[:=]\s*\d+\]?)|(?:press_dtmf\s*\(\s*digit\s*=\s*["']?\d+["']?\s*\))/gi, '')
              .replace(/\[?CALL\s+ENDED\]?/gi, '')
              .replace(/\[?END\s*[:=]\s*[^\]]*\]?/gi, '')
              .replace(/\[?WAITING\]?/gi, '')
              .replace(/wait_for_human\s*\(\s*\)/gi, '')
              .replace(/\[|\]/g, '') // Strip remaining brackets
              .trim()

            if (spokenText) {
              isBotSpeaking = true
              sendToCartesia(spokenText, false)
            }

            if (dtmfDigit) {
              console.log('DO: Pressing DTMF:', dtmfDigit)
              ws.send(JSON.stringify({ event: 'dtmf', streamSid, dtmf: { digit: dtmfDigit } }))
            } else if (isEnd) {
              console.log('DO: End call triggered')
              let status = 'completed'
              let payer = 'unknown'
              let claim_id = 'unknown'
              let amount: number | undefined = undefined
              let next_action = 'none'

              if (endMatch) {
                const parts = endMatch[1].split(':')
                status = parts[0] || 'completed'
                payer = parts[1] || 'unknown'
                claim_id = parts[2] || 'unknown'
                amount = parts[3] ? parseFloat(parts[3]) : undefined
                next_action = parts[4] || 'none'
              }

              const finalizeCall = async () => {
                const startTime = await redis.hget(`call:${callSid}`, 'started_at') as number
                const result = {
                  status,
                  payer, claim_id,
                  amount,
                  next_action,
                  duration_ms: startTime ? (Date.now() - startTime) : 0,
                  ended_at: Date.now()
                }
                await redis.hset(`call:${callSid}`, { ...result, last_error: '' })
                await redis.publish('call-updates', JSON.stringify({ callSid, ...result }))

                // Update the Excel account row in Redis on success
                if (accountUid) {
                  const todayStr = new Date().toLocaleDateString('en-US')
                  const accountUpdate = {
                    'Call Comments': next_action || 'Call completed',
                    'Call Date': todayStr,
                    'Call Status': 'Calls Done'
                  }
                  await redis.hset(`account:${accountUid}`, accountUpdate)
                }

                await closeCall(status)
              }

              // Delay close if we are speaking a final goodbye
              if (spokenText) {
                setTimeout(() => {
                  this.state.waitUntil(finalizeCall())
                }, 3000)
              } else {
                this.state.waitUntil(finalizeCall())
              }
              return
            }
          }
          return // Success!
        } catch (err: any) {
          console.error('DO: Cloudflare Workers AI failed, falling back to OpenAI. Error:', err)
          await redis.hset(`call:${callSid}`, { last_error: `Workers AI failed (falling back to OpenAI): ${err.message || err}` })
          useCF = false
        }
      }

      // 2. Try OpenAI (if useCF is false / fallback)
      if (!useCF) {
        try {
          const openAIModel = model.startsWith('gpt-') ? model : 'gpt-4o-mini'
          console.log('DO: Requesting OpenAI with model:', openAIModel)
          const stream = await openai.chat.completions.create({
            model: openAIModel,
            messages: llmMessages,
            tools: [
              { type: 'function', function: { name: 'press_dtmf', description: 'Press phone keypad digit', parameters: { type: 'object', properties: { digit: { type: 'string' } }, required: ['digit'] } } },
              { type: 'function', function: { name: 'wait_for_human', description: 'Detected hold music', parameters: { type: 'object', properties: {} } } },
              { type: 'function', function: { name: 'end_call', description: 'End call with result', parameters: { type: 'object', properties: { status: { type: 'string' }, payer: { type: 'string' }, claim_id: { type: 'string' }, amount: { type: 'number' }, next_action: { type: 'string' } }, required: ['status'] } } }
            ],
            stream: true,
            temperature: 0
          })

          let botText = ''
          let toolCalls: any[] = []
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta
            if (delta?.content) {
              if (!isBotSpeaking) {
                isBotSpeaking = true
              }
              botText += delta.content
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: tc.id, function: { name: '', arguments: '' } }
                if (tc.function?.name) toolCalls[tc.index].function.name = tc.function.name
                if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments
              }
            }
          }
          console.log('DO: OpenAI stream completed. botText:', botText, 'toolCalls count:', toolCalls.filter(Boolean).length)
          if (botText.trim()) {
            isBotSpeaking = true
            sendToCartesia(botText, false)
            llmMessages.push({ role: 'assistant', content: botText })
            await redis.hset(`call:${callSid}`, { last_llm_response: botText })
          }

          for (const tc of toolCalls) {
            if (!tc) continue
            const name = tc.function.name
            const args = JSON.parse(tc.function.arguments || '{}')
            console.log('DO: Executing tool call:', name, 'with args:', args)
            if (name === 'press_dtmf') {
              ws.send(JSON.stringify({ event: 'dtmf', streamSid, dtmf: { digit: args.digit } }))
              llmMessages.push({ role: 'assistant', tool_calls: [tc] })
              llmMessages.push({ role: 'tool', content: 'DTMF sent', tool_call_id: tc.id })
            }
            if (name === 'end_call') {
              const startTime = await redis.hget(`call:${callSid}`, 'started_at') as number
              const result = { 
                ...args, 
                duration_ms: startTime ? (Date.now() - startTime) : 0,
                ended_at: Date.now(),
                status: args.status || 'completed'
              }
              await redis.hset(`call:${callSid}`, result)
              await redis.publish('call-updates', JSON.stringify({ callSid, ...result }))
              this.state.waitUntil(closeCall(args.status || 'completed'))
            }
          }
        } catch (err: any) {
          console.error('DO: OpenAI failed too. Error:', err)
          await redis.hset(`call:${callSid}`, { last_error: `OpenAI failed: ${err.message || err}` })
        }
      }
    }

    ws.addEventListener('message', async (evt) => {
      try {
        const msg = JSON.parse(evt.data as string)
        if (msg.event === 'start') {
          streamSid = msg.start.streamSid
          openCartesia()
          runLLM(firstGreeting)
        }
        if (msg.event === 'media') {
          const chunk = Buffer.from(msg.media.payload, 'base64')
          if (isDgOpen && dgConnection) {
            dgConnection.send(chunk)
          } else {
            dgQueue.push(chunk)
          }
        }
        if (msg.event === 'stop') {
          this.state.waitUntil(closeCall('disconnected'))
        }
      } catch (err: any) {
        console.error('DO: Error processing message:', err)
        await redis.hset(`call:${callSid}`, { last_error: `Message error: ${err.message || err}` })
        this.state.waitUntil(closeCall('failed'))
      }
    })

    ws.addEventListener('close', () => {
      this.state.waitUntil(closeCall('disconnected'))
    })
  }
}
