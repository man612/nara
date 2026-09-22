# SumoPod deployment preset

SumoPod is an optional hosting target, not an application dependency.

Two reasonable deployment shapes exist:

1. Run Companion Core on a normal container/VPS and point its optional Hermes adapter at a SumoPod Hermes service.
2. If the SumoPod Hermes service exposes enough shell/process/network control, colocate Companion Core there.

Do not assume the managed Hermes app provides Docker nesting, root access, arbitrary public ports or persistent paths until the specific service confirms them.

Required integration surface is intentionally small:

- outbound access from Companion Core to model/search providers;
- a persistent HTTPS/WSS endpoint reachable by the physical device;
- optional HTTP access to Hermes' OpenAI-compatible API;
- persistent storage for memory/config if enabled.

Moving away from SumoPod should require deployment/config changes only, not firmware changes.


## Current companion-service wiring

A first deployment can keep Nara Gateway and Hermes independently replaceable.

Suggested responsibilities:

- Nara Gateway: physical WebSocket/Opus, memory/privacy policy, Telegram,
  weather/briefings, budget/latency telemetry, OTA and the durable idle inbox;
- Hermes on SumoPod: optional long-running browser/research/tool work through
  the Runs API;
- realtime voice provider: opened on demand rather than kept alive merely to
  receive remote messages.

Relevant environment variables:

- `HERMES_BASE_URL`, `HERMES_API_KEY` and optional profile/model/provider;
- `NARA_TELEGRAM_BOT_TOKEN`, `NARA_TELEGRAM_ALLOWED_USER_IDS` and
  `NARA_COMPANION_DEVICE_ID`;
- `NARA_REMOTE_INBOX_FILE` and optional TTL/lease/queue bounds;
- optional weather coordinates/timezone and daily briefing schedule;
- optional DeepSeek/OpenRouter keys for direct balance checks;
- optional `NARA_VOICE_DAILY_TOKEN_BUDGET` for a local soft voice-usage cap.

Persist the gateway `data/` directory if memory, device credentials, OTA
channel policy, human credentials or the remote inbox are enabled. Never bake
provider, Telegram, device or Hermes secrets into firmware images.

The managed-service URL and key remain deployment configuration. Nara does not
assume SumoPod-specific filesystem paths or make SumoPod a firmware
dependency.
