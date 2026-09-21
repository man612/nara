import "dotenv/config";
import { createLibopusWasmCodecFactory } from "./audio/libopus-wasm.js";
import { loadProvidersConfig } from "./config/providers.js";
import { createPersonalContentHttpHandler } from "./content/http.js";
import { PersonalContentService } from "./content/personal-content.js";
import { DeviceRegistry } from "./device/registry.js";
import { FirmwareVoiceBridge } from "./device/voice-bridge.js";
import type { PersonDirectory } from "./identity/directory.js";
import { loadPersonDirectoryFile } from "./identity/file-directory.js";
import { SpeakerIdentityService } from "./identity/speaker.js";
import { HttpSpeakerIdentityProvider } from "./identity/speaker-http.js";
import { SpeakerTurnRecognizer } from "./identity/speaker-turn.js";
import { FilePersonalMemoryStore } from "./memory/personal.js";
import { PersonalMemoryToolProvider } from "./memory/tool-provider.js";
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

type SpeakerRuntime = {
  directory: PersonDirectory;
  service: SpeakerIdentityService;
};

function requiredNumber(name: string): number {
  const raw = process.env[name];
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be configured as a finite number`);
  }
  return value;
}

async function createFirmwareVoiceFactory(
  voiceMemory?: VoiceMemoryRuntime,
  speakerRuntime?: SpeakerRuntime
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
    ...(speakerRuntime
      ? {
          createSpeakerRecognizer: () =>
            new SpeakerTurnRecognizer(speakerRuntime.service),
          onSpeakerIdentity: (session, decision) => {
            if (decision.kind === "known") {
              const person = speakerRuntime.directory.get(decision.personId);
              console.log(
                `[firmware:${session.sessionId}] speaker=${person?.displayName ?? decision.personId} confidence=${decision.confidence.toFixed(3)} margin=${decision.margin.toFixed(3)} provider=${decision.providerId}`
              );
            } else {
              console.log(
                `[firmware:${session.sessionId}] speaker=guest reason=${decision.reason} provider=${decision.providerId}`
              );
            }
          }
        }
      : {}),
    ...(voiceMemory
      ? {
          createToolProviders: () => [
            // Device authentication proves which Nara body connected, not who
            // is currently speaking. Until a strong viewer signal is wired,
            // realtime voice is intentionally guest-scoped and can retrieve
            // public facts only.
            new PersonalMemoryToolProvider(voiceMemory.store, {
              viewerId: "person:guest",
              subjectId: voiceMemory.subjectId
            })
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

  const peopleFile = process.env.NARA_PEOPLE_FILE;
  const speakerEndpoint = process.env.NARA_SPEAKER_ID_URL;
  const speakerConfigPresent =
    peopleFile !== undefined ||
    speakerEndpoint !== undefined ||
    process.env.NARA_SPEAKER_MIN_CONFIDENCE !== undefined ||
    process.env.NARA_SPEAKER_MIN_MARGIN !== undefined ||
    process.env.NARA_SPEAKER_MIN_AUDIO_MS !== undefined;

  let speakerRuntime: SpeakerRuntime | undefined;
  if (speakerConfigPresent) {
    if (!peopleFile || !speakerEndpoint) {
      throw new Error(
        "Speaker identity requires NARA_PEOPLE_FILE and NARA_SPEAKER_ID_URL"
      );
    }

    const directory = await loadPersonDirectoryFile(peopleFile);
    const provider = new HttpSpeakerIdentityProvider(speakerEndpoint, {
      ...(process.env.NARA_SPEAKER_SERVICE_TOKEN
        ? { bearerToken: process.env.NARA_SPEAKER_SERVICE_TOKEN }
        : {})
    });
    speakerRuntime = {
      directory,
      service: new SpeakerIdentityService(provider, directory, {
        minConfidence: requiredNumber("NARA_SPEAKER_MIN_CONFIDENCE"),
        minMargin: requiredNumber("NARA_SPEAKER_MIN_MARGIN"),
        minAudioMs: requiredNumber("NARA_SPEAKER_MIN_AUDIO_MS")
      })
    };
  }

  const firmwareSessionFactory = await createFirmwareVoiceFactory(
    voiceMemory,
    speakerRuntime
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
    if (speakerRuntime && peopleFile) {
      console.log(
        `Speaker identity:  profiles=${speakerRuntime.directory.getSpeakerCandidates().length} primary=${speakerRuntime.directory.getPrimary().displayName} file=${peopleFile}`
      );
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
