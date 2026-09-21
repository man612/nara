import "dotenv/config";
import { createLibopusWasmCodecFactory } from "./audio/libopus-wasm.js";
import { loadProvidersConfig } from "./config/providers.js";
import { createPersonalContentHttpHandler } from "./content/http.js";
import { CompanionRuntime } from "./companion/runtime.js";
import { PersonalContentService } from "./content/personal-content.js";
import { DeviceRegistry } from "./device/registry.js";
import { FirmwareVoiceBridge } from "./device/voice-bridge.js";
import type { PersonDirectory } from "./identity/directory.js";
import { loadPersonDirectoryFile } from "./identity/file-directory.js";
import { HumanCredentialRegistry } from "./identity/human-credentials.js";
import { createHumanAuthHttpHandler } from "./identity/human-auth-http.js";
import { SpeakerIdentityService } from "./identity/speaker.js";
import { HttpSpeakerIdentityProvider } from "./identity/speaker-http.js";
import { SpeakerTurnRecognizer } from "./identity/speaker-turn.js";
import { FilePersonalMemoryStore } from "./memory/personal.js";
import { PersonalMemoryToolProvider } from "./memory/tool-provider.js";
import { SpotifyWebApiProvider } from "./media/spotify.js";
import { MediaToolProvider } from "./media/tool-provider.js";
import { GitHubReleaseOtaCatalog } from "./ota/catalog.js";
import { DeviceUpdateChannels } from "./ota/channels.js";
import { createOtaHttpHandler } from "./ota/http.js";
import { PhoneVoiceBridge } from "./phone/voice-bridge.js";
import { createOfflineCapsuleHttpHandler } from "./offline/capsule-http.js";
import {
  createGatewayServer,
  isGatewayDeviceAuthorized,
  type FirmwareSessionFactory,
  type PhoneSessionFactory,
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
  speakerRuntime: SpeakerRuntime | undefined,
  mediaTools: MediaToolProvider | undefined,
  companion: CompanionRuntime
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
    createToolProviders: (session) => [
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
      ...(mediaTools ? [mediaTools] : []),
      ...companion.toolProviders(session.deviceId)
    ],
    onControlReady: (session, control) => {
      companion.registerVoiceControl(session, control);
    },
    onControlClosed: (session) => {
      companion.unregisterVoiceControl(session);
    },
    onOutputTranscript: (_session, text, final) =>
      companion.handleOutputTranscript(text, final),
    onLatencySample: (sample) => {
      companion.recordLatency(sample);
    }
  });

  console.log(
    `Voice route:        ${voiceProvider.id} (${providersFile})`
  );
  return bridge.createSession;
}

async function createPhoneVoiceFactory(
  voiceMemory: VoiceMemoryRuntime | undefined,
  mediaTools: MediaToolProvider | undefined,
  companion: CompanionRuntime
): Promise<PhoneSessionFactory | undefined> {
  const providersFile = process.env.PROVIDERS_FILE;
  if (!providersFile) return undefined;

  const providersConfig = await loadProvidersConfig(providersFile);
  const voiceProvider = createVoiceChain(providersConfig);
  const bridge = new PhoneVoiceBridge({
    voiceProvider,
    createToolProviders: (context) => [
      ...(voiceMemory
        ? [
            // The transport token and the human viewer credential are
            // separate. Without an authenticated viewer session, phone
            // voice remains guest/public just like physical firmware.
            new PersonalMemoryToolProvider(voiceMemory.store, {
              viewerId: context.viewerId ?? "person:guest",
              subjectId: voiceMemory.subjectId
            })
          ]
        : []),
      ...(mediaTools ? [mediaTools] : []),
      ...companion.toolProviders()
    ],
    onUsage: (usage) => {
      console.log(
        `[phone] voice usage route=${voiceProvider.id} input=${usage.inputTokens ?? "?"} output=${usage.outputTokens ?? "?"} cached=${usage.cachedInputTokens ?? "?"} total=${usage.totalTokens ?? "?"}`
      );
    }
  });
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
  const personDirectory = peopleFile
    ? await loadPersonDirectoryFile(peopleFile)
    : undefined;
  const speakerEndpoint = process.env.NARA_SPEAKER_ID_URL;
  const speakerConfigPresent =
    speakerEndpoint !== undefined ||
    process.env.NARA_SPEAKER_MIN_CONFIDENCE !== undefined ||
    process.env.NARA_SPEAKER_MIN_MARGIN !== undefined ||
    process.env.NARA_SPEAKER_MIN_AUDIO_MS !== undefined;

  let speakerRuntime: SpeakerRuntime | undefined;
  if (speakerConfigPresent) {
    if (!personDirectory || !speakerEndpoint) {
      throw new Error(
        "Speaker identity requires NARA_PEOPLE_FILE and NARA_SPEAKER_ID_URL"
      );
    }

    const directory = personDirectory;
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

  const humanAdminToken = process.env.NARA_HUMAN_AUTH_ADMIN_TOKEN;
  const humanRegistryFile =
    process.env.NARA_HUMAN_CREDENTIAL_REGISTRY_FILE ??
    "data/human-credentials.json";
  const humanAuthConfigured =
    humanAdminToken !== undefined ||
    process.env.NARA_HUMAN_CREDENTIAL_REGISTRY_FILE !== undefined;
  if (humanAuthConfigured && (!humanAdminToken || !personDirectory)) {
    throw new Error(
      "Human viewer auth requires NARA_HUMAN_AUTH_ADMIN_TOKEN and NARA_PEOPLE_FILE"
    );
  }
  const humanRegistry =
    humanAuthConfigured && humanAdminToken && personDirectory
      ? await HumanCredentialRegistry.open({ filePath: humanRegistryFile })
      : undefined;

  const companion = CompanionRuntime.fromEnvironment();

  const firmwareSessionFactory = await createFirmwareVoiceFactory(
    voiceMemory,
    speakerRuntime,
    mediaTools,
    companion
  );
  const phoneToken = process.env.NARA_PHONE_BRIDGE_TOKEN;
  const phoneSessionFactory = phoneToken
    ? await createPhoneVoiceFactory(voiceMemory, mediaTools, companion)
    : undefined;

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

  const capsuleToken = process.env.NARA_OFFLINE_CAPSULE_ADMIN_TOKEN;
  const capsuleRecipientId = process.env.NARA_OFFLINE_CAPSULE_RECIPIENT_ID;
  const capsuleSubjectId = process.env.NARA_OFFLINE_CAPSULE_SUBJECT_ID;
  const capsuleConfigPresent =
    capsuleToken !== undefined ||
    capsuleRecipientId !== undefined ||
    capsuleSubjectId !== undefined;

  if (
    capsuleConfigPresent &&
    (!capsuleToken ||
      !capsuleRecipientId ||
      !capsuleSubjectId ||
      !personalMemoryStore)
  ) {
    throw new Error(
      "Offline capsule export requires NARA_OFFLINE_CAPSULE_ADMIN_TOKEN, " +
        "NARA_OFFLINE_CAPSULE_RECIPIENT_ID, NARA_OFFLINE_CAPSULE_SUBJECT_ID, " +
        "and NARA_PERSONAL_MEMORY_FILE"
    );
  }

  const httpHandlers: NonNullable<GatewayOptions["httpHandlers"]> = [];
  httpHandlers.push(
    companion.networkDiagnosticsHandler((request) =>
      isGatewayDeviceAuthorized(request, {
        ...(deviceToken ? { deviceToken } : {}),
        deviceRegistry
      })
    )
  );
  if (
    capsuleToken &&
    capsuleRecipientId &&
    capsuleSubjectId &&
    personalMemoryStore
  ) {
    httpHandlers.push(
      createOfflineCapsuleHttpHandler({
        store: personalMemoryStore,
        bearerToken: capsuleToken,
        recipientPersonId: capsuleRecipientId,
        subjectPersonId: capsuleSubjectId
      })
    );
  }
  if (humanRegistry && humanAdminToken && personDirectory) {
    httpHandlers.push(
      createHumanAuthHttpHandler({
        registry: humanRegistry,
        directory: personDirectory,
        adminToken: humanAdminToken
      })
    );
  }

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
    ...(phoneToken && phoneSessionFactory
      ? {
          phoneToken,
          phoneSessionFactory,
          ...(humanRegistry
            ? {
                resolvePhoneViewerSession: (sessionToken: string) => {
                  const viewer = humanRegistry.resolveSession(sessionToken);
                  return viewer
                    ? {
                        viewerId: viewer.personId,
                        ...(viewer.accountId
                          ? { accountId: viewer.accountId }
                          : {})
                      }
                    : undefined;
                }
              }
            : {})
        }
      : {}),
    ...(httpHandlers.length > 0 ? { httpHandlers } : {})
  };
  const { server } = createGatewayServer(options);

  server.listen(port, () => {
    console.log(`Companion gateway: http://localhost:${port}`);
    console.log(`Virtual device:   http://localhost:${port}/virtual-device`);
    console.log(`Device registry:  ${deviceRegistryFile}`);
    if (phoneToken && phoneSessionFactory) {
      console.log(`Phone audio:      http://localhost:${port}/phone`);
    }
    if (humanRegistry) {
      console.log(
        `Human viewer auth: credentials=${humanRegistryFile} short-lived phone sessions enabled`
      );
    }
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
    if (mediaTools) {
      console.log("Media control:     Spotify Web API enabled");
    }
    if (capsuleToken && capsuleRecipientId && capsuleSubjectId) {
      console.log(
        `Offline capsule:   subject=${capsuleSubjectId} recipient=${capsuleRecipientId}`
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
    for (const row of companion.describeConfiguration()) {
      console.log(row);
    }
    companion.start();

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
