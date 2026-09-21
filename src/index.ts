import "dotenv/config";
import { createLibopusWasmCodecFactory } from "./audio/libopus-wasm.js";
import { loadProvidersConfig } from "./config/providers.js";
import { createPersonalContentHttpHandler } from "./content/http.js";
import { PersonalContentService } from "./content/personal-content.js";
import { DeviceRegistry } from "./device/registry.js";
import { FirmwareVoiceBridge } from "./device/voice-bridge.js";
import { FilePersonalMemoryStore } from "./memory/personal.js";
import { PersonalMemoryToolProvider } from "./memory/tool-provider.js";
import { SpotifyWebApiProvider } from "./media/spotify.js";
import { MediaToolProvider } from "./media/tool-provider.js";
import { GitHubReleaseOtaCatalog } from "./ota/catalog.js";
import { DeviceUpdateChannels } from "./ota/channels.js";
import { createOtaHttpHandler } from "./ota/http.js";
import {
  createGatewayServer,
  isGatewayDeviceAuthorized,
  type FirmwareSessionFactory,
  type GatewayOptions
} from "./gateway.js";
import { createVoiceChain } from "./provider-registry.js";

type VoiceMemoryRuntime = {
  store: FilePersonalMemoryStore;
  subjectId: string;
};

async function createFirmwareVoiceFactory(
  voiceMemory?: VoiceMemoryRuntime,
  mediaTools?: MediaToolProvider
): Promise<FirmwareSessionFactory | undefined> {
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
      console.log(
        `[firmware:${session.sessionId}] tool call name=${event.name} id=${event.callId ?? "?"}`
      );
    },
    ...(voiceMemory || mediaTools
      ? {
          createToolProviders: () => [
            ...(voiceMemory
              ? [
                  // Device authentication proves which Nara body connected,
                  // not who is currently speaking. Realtime personal recall
                  // therefore remains guest/public-scoped for now.
                  new PersonalMemoryToolProvider(voiceMemory.store, {
                    viewerId: "person:guest",
                    subjectId: voiceMemory.subjectId
                  })
                ]
              : []),
            ...(mediaTools ? [mediaTools] : [])
          ]
        }
      : {})
  });

  console.log(
    `Voice route:        ${voiceProvider.id} (${providersFile})`
  );
  return bridge.createSession;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const deviceToken = process.env.NARA_DEVICE_TOKEN;
  const deviceRegistryFile =
    process.env.NARA_DEVICE_REGISTRY_FILE ?? "data/device-registry.json";
  const deviceRegistry = await DeviceRegistry.open({
    filePath: deviceRegistryFile
  });

  const personalMemoryFile = process.env.NARA_PERSONAL_MEMORY_FILE;
  const memorySubjectId = process.env.NARA_MEMORY_SUBJECT_ID;
  const personalMemoryStore = personalMemoryFile
    ? new FilePersonalMemoryStore(personalMemoryFile)
    : undefined;
  const voiceMemory =
    personalMemoryStore && memorySubjectId
      ? {
          store: personalMemoryStore,
          subjectId: memorySubjectId
        }
      : undefined;

  const spotifyValues = {
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN
  };
  const spotifyConfigured = Object.values(spotifyValues).some(
    (value) => value !== undefined
  );
  let mediaTools: MediaToolProvider | undefined;
  if (spotifyConfigured) {
    if (
      !spotifyValues.clientId ||
      !spotifyValues.clientSecret ||
      !spotifyValues.refreshToken
    ) {
      throw new Error(
        "Spotify media requires SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REFRESH_TOKEN"
      );
    }
    mediaTools = new MediaToolProvider(
      new SpotifyWebApiProvider({
        clientId: spotifyValues.clientId,
        clientSecret: spotifyValues.clientSecret,
        refreshToken: spotifyValues.refreshToken
      })
    );
  }

  const firmwareSessionFactory = await createFirmwareVoiceFactory(
    voiceMemory,
    mediaTools
  );

  const contentToken = process.env.NARA_CONTENT_ADMIN_TOKEN;
  const contentSubjectId = process.env.NARA_CONTENT_AUTHOR_SUBJECT_ID;
  const contentAllowedViewerIds = (
    process.env.NARA_CONTENT_ALLOWED_VIEWER_IDS ?? ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const contentDefaultViewerIds = (
    process.env.NARA_CONTENT_DEFAULT_VIEWER_IDS ??
    process.env.NARA_CONTENT_ALLOWED_VIEWER_IDS ??
    ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const contentConfigPresent =
    contentToken !== undefined ||
    contentSubjectId !== undefined ||
    process.env.NARA_CONTENT_ALLOWED_VIEWER_IDS !== undefined;

  if (
    contentConfigPresent &&
    (!contentToken ||
      !contentSubjectId ||
      !personalMemoryStore ||
      contentAllowedViewerIds.length === 0)
  ) {
    throw new Error(
      "Remote personal content requires NARA_CONTENT_ADMIN_TOKEN, " +
        "NARA_CONTENT_AUTHOR_SUBJECT_ID, NARA_CONTENT_ALLOWED_VIEWER_IDS, " +
        "and NARA_PERSONAL_MEMORY_FILE"
    );
  }

  const httpHandlers: NonNullable<GatewayOptions["httpHandlers"]> = [];
  if (contentToken && contentSubjectId && personalMemoryStore) {
    const contentService = new PersonalContentService(personalMemoryStore, {
      subjectId: contentSubjectId,
      allowedViewerIds: contentAllowedViewerIds,
      defaultViewerIds: contentDefaultViewerIds,
      allowPublic:
        process.env.NARA_CONTENT_ALLOW_PUBLIC?.toLowerCase() === "true"
    });
    httpHandlers.push(
      createPersonalContentHttpHandler({
        service: contentService,
        bearerToken: contentToken
      })
    );
  }

  const otaRepository = process.env.NARA_OTA_GITHUB_REPO;
  if (otaRepository) {
    const otaChannels = await DeviceUpdateChannels.open({
      filePath:
        process.env.NARA_OTA_CHANNELS_FILE ??
        "data/device-update-channels.json"
    });
    const otaCatalog = new GitHubReleaseOtaCatalog(otaRepository, {
      ...(process.env.NARA_OTA_GITHUB_TOKEN
        ? { githubToken: process.env.NARA_OTA_GITHUB_TOKEN }
        : {})
    });
    httpHandlers.push(
      createOtaHttpHandler({
        catalog: otaCatalog,
        channels: otaChannels,
        authorizeDevice: (request) =>
          isGatewayDeviceAuthorized(request, {
            ...(deviceToken ? { deviceToken } : {}),
            deviceRegistry
          }),
        ...(process.env.NARA_OTA_ADMIN_TOKEN
          ? { adminToken: process.env.NARA_OTA_ADMIN_TOKEN }
          : {})
      })
    );
  }

  const options: GatewayOptions = {
    ...(deviceToken ? { deviceToken } : {}),
    deviceRegistry,
    ...(firmwareSessionFactory ? { firmwareSessionFactory } : {}),
    ...(httpHandlers.length > 0 ? { httpHandlers } : {})
  };
  const { server } = createGatewayServer(options);

  server.listen(port, () => {
    console.log(`Companion gateway: http://localhost:${port}`);
    console.log(`Virtual device:   http://localhost:${port}/virtual-device`);
    console.log(`Device registry:  ${deviceRegistryFile}`);
    if (voiceMemory) {
      console.log(
        `Voice memory:      guest/public scope subject=${voiceMemory.subjectId} file=${personalMemoryFile}`
      );
    }
    if (mediaTools) {
      console.log("Media control:     Spotify Web API enabled");
    }
    if (contentToken && contentSubjectId) {
      console.log(
        `Personal content:  scoped author subject=${contentSubjectId} viewers=${contentAllowedViewerIds.join(",")}`
      );
    }
    if (otaRepository) {
      console.log(`OTA catalog:       GitHub releases ${otaRepository}`);
    }

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
