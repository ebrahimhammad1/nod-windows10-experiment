# Local full-app e2e harness (no live APIs, no device)

Validates the production path of the running Nod app against a controlled
mock provider. Used for the 2026-11-26 checkpoint.

Setup:
1. `npx vite build` (server serves dist/web only when it exists at startup).
2. Start a local Postgres and create an empty database, e.g. `nodapp`.
3. `DATABASE_URL=postgres://.../nodapp NOD_DATA_ROOT=/tmp/nodapp-data PORT=4310 NODE_ENV=production npx tsx src/server/index.ts`
   (keep alive across shells with setsid + nohup; access key lands in
   $NOD_DATA_ROOT/access-key, app URL is http://localhost:4310/#access=<key>).
4. `python3 mock_openai.py` (127.0.0.1:4399): OpenAI-compatible fixture.
   GET /v1/models lists fixture-pro-1; POST /v1/chat/completions streams SSE;
   a user text containing "weather" triggers one scripted tool call (read
   with a valid path argument) so the real tool pipeline is exercised.
5. Connect through the REAL API:
   `curl -X POST localhost:4310/api/models/endpoints -H 'Content-Type: application/json' -H "Cookie: nod-access-4310=<key>" -d '{"url":"http://127.0.0.1:4399/v1"}'`
6. Drive the real UI in headless Chrome via CDP
   (`google-chrome --headless=new --remote-debugging-port=9222`):
   - cdp_shot.mjs <url> <out.png> <settleMs> [clickX clickY]
   - cdp_click_text.mjs <url|same> <out.png> <settleMs> <buttonText|none>
   - cdp_send.mjs <message> <out.png> <waitMs> (types into the composer and sends)
   Note: an old cached index.html can reference stale asset hashes; the
   scripts disable the network cache. The welcome/onboarding flow completes
   once per data root (Get started > Continue without email > skip > skip > skip > Continue > Start chatting).

Findings (2026-11-26, cand @ 1a8db493):
- Real turn pipeline: user message -> provider stream -> reply render ->
  Postgres persistence (verified in messages table).
- Ack ordering: "Got it, I've started working on this." streams and persists
  BEFORE tool dispatch.
- Tool contract: argument schema fencing returns a tool error
  (`Validation failed for tool "read": path: missing`) as a tool result;
  with valid arguments the dispatch reaches the workspace sandbox and fails
  cleanly on `spawn docker EACCES` in this sandbox (environment limit).
- First turn fires 4 auxiliary no-tool provider requests (title/suggestions)
  before the chat turn: real per-turn overhead, relevant to payload work.
- Effort picker is hidden when the selected model offers <2 efforts
  (effort-picker.tsx: `efforts.length < 2 -> null`). Endpoint-discovered
  compatible models always get reasoning:false -> efforts ["off"] only
  (pi-ai getSupportedThinkingLevels), so the picker (and Auto) never shows
  for custom-endpoint connections in the real app.
