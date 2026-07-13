export interface Env {
  CALL_SESSION: DurableObjectNamespace
  UPSTASH_REDIS_REST_URL: string
  UPSTASH_REDIS_REST_TOKEN: string
  AZURE_OPENAI_KEY: string
  AZURE_OPENAI_ENDPOINT: string
  AZURE_OPENAI_DEPLOYMENT: string
  AZURE_OPENAI_API_VERSION: string
  DEEPGRAM_KEY: string
  CARTESIA_KEY: string
  CARTESIA_VOICE_ID: string
}

export interface CallResult {
  callSid: string
  status: 'ready' | 'failed' | 'escalate'
  payer?: string
  claim_id?: string
  amount?: number
  next_action?: string
  duration_ms?: number
}
