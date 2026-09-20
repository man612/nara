import "dotenv/config";
import { createLibopusWasmCodecFactory } from "./audio/libopus-wasm.js";
import { loadProvidersConfig } from "./config/providers.js";
import { FirmwareVoiceBridge } from "./device/voice-bridge.js";
import {
  createGatewayServer,
  type FirmwareSessionFactory,
  type GatewayOptions
} from "./gateway.js";
import { createVoiceChain } from "./provider-registry.js";

async function createFirmwareVoiceFactory(): Promise<
  FirmwareSessionFactory | undefined
> {
  const providersFile = process.env.PROVIDERS_FILE;
  if (!providersFile) {
    return undefined;
  }

  const providersConfig = await loadProvidersConfig(providersFile);
  const voiceProvider = createVoiceChain(providersConfig);
  const bridge = new FirmwareVoiceBridge({
    voiceProvider,
    codecFactory: createLibopusWasmCodecFactory(),
    onUsage: (session, usage) => {
      console.log(
        `[firmware:${session.sessionId}] voice usage route=${voiceProvider.id} input=${usage.inputTokens ?? "?"} output=${usage.outputTokens ?? "?"} cached=${usage.cachedInputTokens ?? "?"} total=${usage.totalTokens ?? "?"}`
      );
    },
    onToolCall: (session, event) => {
      console.warn(
        `[firmware:${session.sessionId}] voice tool call is not wired yet: ${event.name}`
      );
    }
  });

  console.log(
    `Voice route:        ${voiceProvider.id} (${providersFile})`
  );
  return bridge.createSession;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const deviceToken = process.env.NARA_DEVICE_TOKEN;
  const firmwareSessionFactory = await createFirmwareVoiceFactory();

  const options: GatewayOptions = {
    ...(deviceToken ? { deviceToken } : {}),
    ...(firmwareSessionFactory ? { firmwareSessionFactory } : {})
  };
  const { server } = createGatewayServer(options);

  server.listen(port, () => {
    console.log(`Companion gateway: http://localhost:${port}`);
    console.log(`Virtual device:   http://localhost:${port}/virtual-device`);

    if (!deviceToken) {
      console.warn(
        "NARA_DEVICE_TOKEN is not set; /device accepts unauthenticated clients"
      );
    }
    if (!firmwareSessionFactory) {
      console.warn(
        "PROVIDERS_FILE is not set; physical firmware voice sessions are disabled"
      );
    }
  });
}

void main().catch((error) => {
  console.error("Failed to start Nara gateway", error);
  process.exitCode = 1;
});
