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
    const callSid = url.searchParams.get('callSid')
    console.log('DO: callSid =', callSid)
    if (!callSid) {
      ws.close(1008, 'Missing callSid')
      return
    }

    const redis = Redis.fromEnv(this.env)

    let streamSid = ''
    let isBotSpeaking = false
    let silenceMs = await this.state.storage.get('silenceMs') || 0

    const silenceTimer = setInterval(async () => {
      silenceMs += 100
      await this.state.storage.put('silenceMs', silenceMs)
      if (silenceMs > 19 * 60 * 1000) {
        await this.state.storage.setAlarm(Date.now() + 30 * 1000)
      }
    }, 100)

    const openai = new OpenAI({ apiKey: this.env.OPENAI_API_KEY })

    const deepgram = createClient(this.env.DEEPGRAM_KEY)
    const dgConnection = deepgram.listen.live({
      model: 'nova-2-medical',
      language: 'en-US',
      smart_format: true,
      interim_results: true,
      endpointing: 300,
      utterance_end_ms: 1000,
      vad_events: true
    })

    let cartesiaWs: WebSocket | null = null
    const openCartesia = () => {
      cartesiaWs = new WebSocket('wss://api.cartesia.ai/tts/websocket?api_key=' + this.env.CARTESIA_KEY)
      cartesiaWs.addEventListener('open', () => {
        cartesiaWs!.send(JSON.stringify({
          context_id: streamSid,
          model_id: 'sonic-english',
          voice: { mode: 'id', id: this.env.CARTESIA_VOICE_ID },
          output_format: { container: 'raw', encoding: 'mulaw', sample_rate: 8000 },
          language: 'en'
        }))
      })
      cartesiaWs.addEventListener('message', (msg) => {
        const data = JSON.parse(msg.data)
        if (data.type === 'chunk' && data.data) {
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: data.data } }))
        }
        if (data.type === 'done') isBotSpeaking = false
      })
    }

    let llmMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: 'system', content: `You are an AR specialist calling insurance payers.
Rules:
1. If you hear "Press 1 for claims", remain silent and call press_dtmf(digit="1"). Never say "pressing 1".
2. If silence >3s and you hear music/tones, call wait_for_human().
3. When rep asks for claim #, ask user.
4. At end, call end_call with JSON: {status, payer, claim_id, amount, next_action}.
5. Never give medical advice. Keep responses <15 words.` }
    ]

    const runLLM = async (userText: string) => {
      if (isBotSpeaking) {
        ws.send(JSON.stringify({ event: 'clear', streamSid }))
        cartesiaWs?.send(JSON.stringify({ context_id: streamSid, type: 'flush' }))
        isBotSpeaking = false
      }

      llmMessages.push({ role: 'user', content: userText })
      const stream = await openai.chat.completions.create({
        model: this.env.LLM_MODEL || "gpt-5-nano",
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
          botText += delta.content
          if (!isBotSpeaking) {
            isBotSpeaking = true
            if (!cartesiaWs || cartesiaWs.readyState !== 1) openCartesia()
          }
          cartesiaWs?.send(JSON.stringify({ type: 'text', text: delta.content, context_id: streamSid, continue: true }))
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: tc.id, function: { name: '', arguments: '' } }
            if (tc.function?.name) toolCalls[tc.index].function.name = tc.function.name
            if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments
          }
        }
      }
      cartesiaWs?.send(JSON.stringify({ type: 'text', text: ' ', context_id: streamSid, continue: false }))
      if (botText) llmMessages.push({ role: 'assistant', content: botText })

      for (const tc of toolCalls) {
        const name = tc.function.name
        const args = JSON.parse(tc.function.arguments || '{}')
        if (name === 'press_dtmf') {
          ws.send(JSON.stringify({ event: 'dtmf', streamSid, dtmf: { digit: args.digit } }))
          llmMessages.push({ role: 'assistant', tool_calls: [tc] })
          llmMessages.push({ role: 'tool', content: 'DTMF sent', tool_call_id: tc.id })
        }
        if (name === 'end_call') {
          const startTime = await redis.hget(`call:${callSid}`, 'started_at') as number
          const result = { callSid, ...args, duration_ms: Date.now() - startTime }
          await fetch(new URL('/call-result', req.url).toString(), { method: 'POST', body: JSON.stringify(result) })
          ws.close()
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
        cartesiaWs?.send(JSON.stringify({ context_id: streamSid, type: 'flush' }))
        isBotSpeaking = false
      }
    })
    dgConnection.on(LiveTranscriptionEvents.VadEvents, (evt) => {
      if (evt.label === 'speech' && silenceMs > 3000) runLLM('[Hold music detected]')
    })

    ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data as string)
      if (msg.event === 'start') {
        streamSid = msg.start.streamSid
        runLLM('[Call connected]')
      }
      if (msg.event === 'media') dgConnection.send(Buffer.from(msg.media.payload, 'base64'))
      if (msg.event === 'stop') {
        dgConnection.finish()
        cartesiaWs?.close()
        clearInterval(silenceTimer)
        ws.close()
      }
    })

    ws.addEventListener('close', async () => {
      clearInterval(silenceTimer)
      const current = await redis.hget(`call:${callSid}`, 'status')
      if (current !== 'completed') {
        await fetch(new URL('/call-result', req.url).toString(), { method: 'POST', body: JSON.stringify({ callSid, status: 'failed' }) })
      }
    })
  }
}
