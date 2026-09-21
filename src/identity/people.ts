export type PersonBinding = {
  personId: string;
  accountIds?: string[];
};

export type ViewerResolutionInput = {
  /**
   * A person identity already verified by a stronger local/account flow.
   * Do not pass a raw claimed name or speech-transcription guess here.
   */
  verifiedPersonId?: string;

  /**
   * Account identity established by the account authentication layer.
   */
  authenticatedAccountId?: string;

  /**
   * Speaker recognition may be useful for greetings/preferences, but is
   * deliberately not accepted as authorization for personal-memory access.
   */
  speakerCandidate?: {
    personId: string;
    confidence: number;
  };
};

export type ViewerResolution = {
  viewerId: string;
  source: "verified_person" | "authenticated_account" | "guest";
};

export class KnownPersonResolver {
  private readonly accountToPerson = new Map<string, string>();
  private readonly knownPeople = new Set<string>();

  constructor(
    bindings: PersonBinding[],
    private readonly guestPersonId = "person:guest"
  ) {
    this.knownPeople.add(guestPersonId);

    for (const binding of bindings) {
      if (!binding.personId.trim()) {
        throw new Error("personId must not be empty");
      }
      if (this.knownPeople.has(binding.personId)) {
        throw new Error(`Duplicate person binding: ${binding.personId}`);
      }

      this.knownPeople.add(binding.personId);
      for (const accountId of binding.accountIds ?? []) {
        if (!accountId.trim()) {
          throw new Error("accountId must not be empty");
        }
        const existing = this.accountToPerson.get(accountId);
        if (existing && existing !== binding.personId) {
          throw new Error(`Account ${accountId} is bound to multiple people`);
        }
        this.accountToPerson.set(accountId, binding.personId);
      }
    }
  }

  resolve(input: ViewerResolutionInput): ViewerResolution {
    if (
      input.verifiedPersonId &&
      this.knownPeople.has(input.verifiedPersonId)
    ) {
      return {
        viewerId: input.verifiedPersonId,
        source: "verified_person"
      };
    }

    if (input.authenticatedAccountId) {
      const personId = this.accountToPerson.get(input.authenticatedAccountId);
      if (personId) {
        return {
          viewerId: personId,
          source: "authenticated_account"
        };
      }
    }

    // Intentionally ignore speakerCandidate here. Voice identity is a
    // personalization hint, not a privilege-escalation mechanism.
    return {
      viewerId: this.guestPersonId,
      source: "guest"
    };
  }
}
