# Action runtime

Nara treats actions as a provider-neutral capability. Voice models, brain models, device protocols, MCP revisions, and agent backends are adapters around Nara's own tool contracts.

## Core flow

```text
voice / brain provider
        |
        | ToolCall
        v
   ActionRuntime
        |
        +-- DeviceMcpToolProvider --> firmware MCP --> physical device
        +-- PersonalMemoryToolProvider --> viewer-filtered local memory
        +-- HermesAgentToolProvider --> optional Hermes Runs delegation
        +-- MediaToolProvider / CompanionStatusToolProvider
        +-- SearchToolProvider --> SearchProvider --> SearXNG / future adapters
        +-- future external MCP
        |
        | ToolResult
        v
voice / brain provider
```

The runtime owns routing, duplicate-name rejection, a limit on the exposed tool catalog, per-call cancellation, and provider lifecycle.

## Device MCP compatibility

Current Nara firmware inherited a session-oriented MCP server that speaks protocol version `2024-11-05` over the existing device WebSocket.

That legacy protocol is deliberately contained inside `DeviceMcpToolProvider`. It is not Nara's internal action protocol and must not leak into voice-provider or brain-provider contracts.

The first safe aliases are:

- `device_get_status` -> `self.get_device_status`
- `device_set_volume` -> `self.audio_speaker.set_volume`

Nara exposes compact aliases to models because model-facing function names should be portable and token-efficient. Before the first physical action, the device provider performs the legacy `initialize` handshake and `tools/list` discovery, then refuses to invoke a mapped MCP tool that the connected device did not actually advertise.

Sensitive firmware MCP tools such as reboot and firmware upgrade are not exposed to the AI action catalog.

## Voice integration

`VoiceProvider.connect({ tools })` receives Nara tool definitions. The provider adapter translates them into its native declaration format.

`VoiceSession.sendToolResult(result)` translates Nara results back into the provider's native tool-response format.

Gemini Live currently maps:

```text
ToolDefinition -> setup.tools[].functionDeclarations
ToolResult     -> toolResponse.functionResponses
```

Provider `toolCallCancellation` messages become the provider-neutral `tool.cancel` event.

## Lifecycle rule

Speech interruption and action cancellation are separate lifecycles.

Stopping playback must not implicitly cancel a search, device action, browser task, or long-running agent job. A tool call is cancelled only when its call ID is explicitly cancelled or the whole firmware session closes.

Tool execution is intentionally not awaited inside the serialized voice-event chain. Otherwise a provider cancellation event could be stuck behind the tool call that it is trying to cancel.

## Cost rule

Do not expose every possible tool to every live session.

The action runtime has an explicit tool-count guard and the physical-device catalog is intentionally compact. Memory, media, companion-status, dedicated web search and optional Hermes tools are selected through the same provider boundary. Search is exposed only when a `search:` route exists in provider configuration, so unused search schemas do not permanently consume realtime voice context. Future automation and external MCP tools should follow the same per-session/intent rule.
