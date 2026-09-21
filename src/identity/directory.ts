import type { PersonBinding } from "./people.js";

export const MAX_ENROLLED_SPEAKERS = 6;

export type PersonRole =
  | "primary"
  | "creator"
  | "household"
  | "trusted"
  | "guest";

export type PersonProfile = {
  personId: string;
  displayName: string;
  role: PersonRole;
  accountIds?: string[];
  speakerProfileId?: string;
  speakerEnabled?: boolean;
  relationships?: string[];
};

export type SpeakerProfileRef = {
  personId: string;
  profileId: string;
};

function requireText(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} must not be empty`);
  }
}

export class PersonDirectory {
  private readonly people = new Map<string, PersonProfile>();
  private readonly primaryPersonId: string;
  private readonly guestPersonId: string;

  constructor(
    profiles: PersonProfile[],
    options: { guestPersonId?: string } = {}
  ) {
    this.guestPersonId = options.guestPersonId ?? "person:guest";

    const primary = profiles.filter((profile) => profile.role === "primary");
    if (primary.length !== 1) {
      throw new Error("Person directory requires exactly one primary person");
    }
    this.primaryPersonId = primary[0]!.personId;

    const speakerProfileIds = new Set<string>();
    let enabledSpeakers = 0;

    for (const profile of profiles) {
      requireText(profile.personId, "personId");
      requireText(profile.displayName, "displayName");

      if (this.people.has(profile.personId)) {
        throw new Error(`Duplicate person profile: ${profile.personId}`);
      }
      if (profile.personId === this.guestPersonId && profile.role !== "guest") {
        throw new Error("Guest person ID must use the guest role");
      }

      if (profile.speakerEnabled) {
        if (!profile.speakerProfileId) {
          throw new Error(
            `Speaker-enabled person ${profile.personId} requires speakerProfileId`
          );
        }
        if (profile.role === "guest") {
          throw new Error("Guest cannot have an enrolled speaker profile");
        }
        if (speakerProfileIds.has(profile.speakerProfileId)) {
          throw new Error(
            `Duplicate speaker profile ID: ${profile.speakerProfileId}`
          );
        }
        speakerProfileIds.add(profile.speakerProfileId);
        enabledSpeakers += 1;
      }

      this.people.set(profile.personId, structuredClone(profile));
    }

    if (enabledSpeakers > MAX_ENROLLED_SPEAKERS) {
      throw new Error(
        `At most ${MAX_ENROLLED_SPEAKERS} speaker profiles may be enabled`
      );
    }
  }

  getPrimary(): PersonProfile {
    return structuredClone(this.people.get(this.primaryPersonId)!);
  }

  get(personId: string): PersonProfile | undefined {
    const profile = this.people.get(personId);
    return profile ? structuredClone(profile) : undefined;
  }

  getGuestPersonId(): string {
    return this.guestPersonId;
  }

  getSpeakerCandidates(): SpeakerProfileRef[] {
    return [...this.people.values()]
      .filter(
        (profile) =>
          profile.speakerEnabled === true &&
          profile.speakerProfileId !== undefined
      )
      .map((profile) => ({
        personId: profile.personId,
        profileId: profile.speakerProfileId!
      }));
  }

  getBindings(): PersonBinding[] {
    return [...this.people.values()]
      .filter((profile) => profile.role !== "guest")
      .map((profile) => ({
        personId: profile.personId,
        ...(profile.accountIds ? { accountIds: [...profile.accountIds] } : {})
      }));
  }
}
