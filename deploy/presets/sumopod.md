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
