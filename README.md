# Healthcare AR Voice Agent

Serverless voice agent for insurance AR calls. Lunabill-style stack: Twilio + Deepgram + Azure OpenAI + Cartesia on Cloudflare Workers.

**Cost**: ~$0.02/min all-in. **Latency**: <800ms. **$0 start** with Azure $200 credit.

### Setup
1. Azure: `az deployment sub create --location eastus2 --template-file scripts/deploy-azure.bicep` then sign BAA
2. Keys: `cp.dev.vars.example.dev.vars` and fill in, then `wrangler secret put AZURE_OPENAI_KEY` etc
3. Deploy: `npm install && npx wrangler deploy`
4. Twilio: Point voice webhook to `https://ar-voice-agent.YOUR.workers.dev/voice`
5. Dashboard: `https://ar-voice-agent.YOUR.workers.dev/dashboard`

### HIPAA
Sign Azure BAA. Use `nova-2-medical` + `Cartesia Sonic`. Redact PHI in prompts. Enable diagnostic logs.
