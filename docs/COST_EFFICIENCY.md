# Cost and token efficiency

Cost efficiency is a product requirement, not a provider-specific tweak.

## 1. Keep deterministic behavior off the model

Blinking, gaze drift, idle animation, mouth amplitude, touch reactions, IMU reactions, device state transitions, and basic UI behavior run locally.

Do not spend model tokens deciding whether an eye should blink.

## 2. Do not keep paid live voice open while Nara is idle

The physical device should keep local wake/VAD available continuously, but a cloud realtime voice session should be opened only for an active conversation and closed after an idle timeout.

This matters especially for native-audio services that bill accumulated audio input while a session is listening.

Provider adapters must expose lifecycle events so Nara can implement the same policy across vendors.

## 3. Transcription is optional

Input/output transcripts are useful for memory, debugging, search, and accessibility, but some realtime providers charge additional text-output tokens for transcription.

Default policy:
- request transcripts only when a feature actually consumes them;
- do not persist full raw transcripts forever;
- prefer compact conversation summaries plus a small recent-turn window.

## 4. Stable prompt prefixes first

For text/reasoning providers, keep stable material at the beginning of the request:
1. stable system/identity instructions;
2. stable tool schema;
3. stable character/profile rules;
4. compact conversation summary;
5. retrieved memory/tool context;
6. recent turns and the new user request.

This improves cache reuse on providers that cache repeated prompt prefixes.

## 5. Retrieve less, not everything

Memory/search/tool adapters should return the smallest useful context.

Initial targets:
- retrieve a handful of relevant memories instead of the whole memory store;
- cap search results and tool output;
- strip navigation/chrome/log noise;
- prefer structured fields over prose when a tool returns machine-readable data.

Limits remain configurable because different models and tasks need different budgets.

## 6. Measure provider usage

Every provider adapter should normalize available usage into:
- input tokens;
- output tokens;
- total tokens;
- cached input tokens;
- uncached input tokens.

Do not hard-code pricing into provider adapters. Prices change. A separate cost layer can combine normalized usage with a current pricing table.

## 7. Cheap-default, explicit escalation

Nara should make it easy to route routine reasoning to a cheap/fast model and delegate only genuinely difficult tasks to a stronger provider.

Avoid adding another LLM call just to classify every request. Prefer:
- direct tool intent from the active voice model;
- deterministic rules for obvious operations;
- explicit escalation by the agent when it needs deeper reasoning.

## 8. Search only when freshness matters

Internet search is a tool, not a permanent context source. Do not search on every turn.

## 9. Preserve provider caching

DeepSeek context caching is automatic and benefits exact repeated prefixes. Keep identity/tool definitions stable rather than regenerating or reordering them every request.

Other providers have their own caching/session mechanisms; adapters can optimize internally without changing Nara's device protocol.

## 10. Coding-agent token efficiency

Repository structure also matters for Codex/other agents:
- start with `AGENTS.md`;
- use `docs/REPO_MAP.md` instead of scanning the repository;
- search with `rg` before opening large files;
- read only the board/provider/component being changed;
- keep architectural decisions in short focused docs;
- do not ask an agent to rediscover decisions already recorded in the repo.
