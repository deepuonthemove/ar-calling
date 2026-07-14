import { Buffer } from 'node:buffer'
import { Redis } from '@upstash/redis/cloudflare'
import OpenAI from 'openai'
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk'
import type { Env } from './types'

export class CallSession {
  state: DurableObjectState
  env: Env
  sessions: Set<WebSocket>

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
    this.sessions = new Set()
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

    const redis = Redis.fromEnv(this.env)

    let streamSid = ''
    let isBotSpeaking = false
    let silenceMs = 0

    const silenceTimer = setInterval(() => {
      silenceMs += 100
      if (silenceMs > 19 * 60 * 1000) {
        clearInterval(silenceTimer)
        ws.close(1011, 'Max silence reached')
      }
    }, 100)

    let openai: OpenAI
    let deepgram: ReturnType<typeof createClient>
    let dgConnection: any
    try {
      openai = new OpenAI({ apiKey: this.env.OPENAI_API_KEY })
      deepgram = createClient(this.env.DEEPGRAM_KEY)
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
    } catch (err: any) {
      console.error('DO: Fatal initialization error:', err)
      const redis = Redis.fromEnv(this.env)
      await redis.hset(`call:${callSid}`, { last_error: `Init error: ${err.message || err}` })
      ws.close(1011, `DO init error: ${err.message || err}`)
      return
    }

    let isDgOpen = false
    const dgQueue: Buffer[] = []

    dgConnection.on(LiveTranscriptionEvents.Open, () => {
      console.log('DO: Deepgram connection opened')
      isDgOpen = true
      while (dgQueue.length > 0) {
        const chunk = dgQueue.shift()
        if (chunk) dgConnection.send(chunk)
      }
    })

    dgConnection.on(LiveTranscriptionEvents.Error, async (err: any) => {
      console.error('DO: Deepgram error:', err)
      await redis.hset(`call:${callSid}`, { last_error: `Deepgram error: ${err.message || err}` })
    })

    dgConnection.on(LiveTranscriptionEvents.Close, () => {
      console.log('DO: Deepgram connection closed')
      isDgOpen = false
    })

    let cartesiaWs: WebSocket | null = null
    let isCartesiaOpen = false
    const cartesiaQueue: string[] = []
    let isFirstCartesiaChunk = true

    const openCartesia = async () => {
      isFirstCartesiaChunk = true
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
        })
      } catch (err: any) {
        console.error("DO: Exception opening Cartesia:", err)
        await redis.hset(`call:${callSid}`, { last_error: `Cartesia connection error: ${err.message || err}` })
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

    let llmMessages: any[] = [
      {
        role: 'system', content: `You are an AR specialist calling insurance payers.
Rules:
1. If you hear a menu like "Press 1 for claims", output ONLY this exact text: [DTMF:1] - nothing else.
2. If silence >3s and you hear music/hold tones, output ONLY: [WAITING]
3. When the call is resolved, output ONLY: [END:completed:PrayerName:ClaimID:Amount:NextAction] filling in the real values.
4. For normal conversation, respond naturally in under 15 words.
5. Never say things like "pressing 1" or describe your actions - just do them with the markers above.` }
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

            // Parse and execute text-based action commands
            const dtmfMatch = botText.match(/\[DTMF:(\d+)\]/)
            const waitMatch = botText.match(/\[WAITING\]/)
            const endMatch = botText.match(/\[END:([^\]]+)\]/)

            if (dtmfMatch) {
              console.log('DO: Pressing DTMF:', dtmfMatch[1])
              ws.send(JSON.stringify({ event: 'dtmf', streamSid, dtmf: { digit: dtmfMatch[1] } }))
            } else if (endMatch) {
              const [status, payer, claim_id, amount, next_action] = endMatch[1].split(':')
              console.log('DO: End call with result:', endMatch[1])
              const startTime = await redis.hget(`call:${callSid}`, 'started_at') as number
              const result = {
                status: status || 'completed',
                payer, claim_id,
                amount: amount ? parseFloat(amount) : undefined,
                next_action,
                duration_ms: startTime ? (Date.now() - startTime) : 0,
                ended_at: Date.now()
              }
              await redis.hset(`call:${callSid}`, { ...result, last_error: '' })
              await redis.publish('call-updates', JSON.stringify({ callSid, ...result }))
              ws.close()
              return
            } else if (!waitMatch) {
              // Normal speech - speak to Cartesia (strip any leftover markers)
              const spokenText = botText.replace(/\[DTMF:\d+\]|\[WAITING\]|\[END:[^\]]*\]/g, '').trim()
              if (spokenText) {
                isBotSpeaking = true
                sendToCartesia(spokenText, false)
              }
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
              ws.close()
            }
          }
        } catch (err: any) {
          console.error('DO: OpenAI failed too. Error:', err)
          await redis.hset(`call:${callSid}`, { last_error: `OpenAI failed: ${err.message || err}` })
        }
      }
    }

    dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
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
    dgConnection.on(LiveTranscriptionEvents.VadEvents, (evt) => {
      if (evt.label === 'speech' && silenceMs > 3000) runLLM('[Hold music detected]')
    })

    ws.addEventListener('message', async (evt) => {
      try {
        const msg = JSON.parse(evt.data as string)
        if (msg.event === 'start') {
          streamSid = msg.start.streamSid
          openCartesia()
          runLLM('[Call connected]')
        }
        if (msg.event === 'media') {
          const chunk = Buffer.from(msg.media.payload, 'base64')
          if (isDgOpen) {
            dgConnection.send(chunk)
          } else {
            dgQueue.push(chunk)
          }
        }
        if (msg.event === 'stop') {
          dgConnection.finish()
          cartesiaWs?.close()
          clearInterval(silenceTimer)
          ws.close()
        }
      } catch (err: any) {
        console.error('DO: Error processing message:', err)
        await redis.hset(`call:${callSid}`, { last_error: `Message error: ${err.message || err}` })
        ws.close(1011, `Message error: ${err.message || err}`)
      }
    })

    ws.addEventListener('close', () => {
      clearInterval(silenceTimer)
      const cleanup = async () => {
        try {
          const current = await redis.hget(`call:${callSid}`, 'status')
          if (current !== 'completed' && current !== 'ready' && current !== 'failed' && current !== 'disconnected') {
            const startTime = await redis.hget(`call:${callSid}`, 'started_at') as number
            const result = {
              status: 'disconnected',
              ended_at: Date.now(),
              duration_ms: startTime ? (Date.now() - startTime) : 0
            }
            await redis.hset(`call:${callSid}`, result)
            await redis.publish('call-updates', JSON.stringify({ callSid, ...result }))
          }
        } catch (err) {
          console.error('DO: Error in close cleanup:', err)
        }
      }
      this.state.waitUntil(cleanup())
    })
  }
}
