export interface Env {
  CALL_SESSION: DurableObjectNamespace
  UPSTASH_REDIS_REST_URL: string
  UPSTASH_REDIS_REST_TOKEN: string
  DEEPGRAM_KEY: string
  CARTESIA_KEY: string
  CARTESIA_VOICE_ID: string
  OPENAI_API_KEY: string;
  LLM_MODEL: string; // add this
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
