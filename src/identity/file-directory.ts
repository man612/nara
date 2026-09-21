import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  PersonDirectory,
  type PersonProfile
} from "./directory.js";

const PersonProfileSchema = z.object({
  personId: z.string().min(1),
  displayName: z.string().min(1),
  role: z.enum(["primary", "creator", "household", "trusted", "guest"]),
  accountIds: z.array(z.string().min(1)).max(32).optional(),
  speakerProfileId: z.string().min(1).optional(),
  speakerEnabled: z.boolean().optional(),
  relationships: z.array(z.string().min(1)).max(32).optional()
});

const PersonDirectoryFileSchema = z.object({
  version: z.literal(1),
  guestPersonId: z.string().min(1).optional(),
  profiles: z.array(PersonProfileSchema).min(1).max(64)
});

export async function loadPersonDirectoryFile(
  filePath: string
): Promise<PersonDirectory> {
  const raw = await readFile(filePath, "utf8");
  const parsed = PersonDirectoryFileSchema.parse(JSON.parse(raw) as unknown);

  const profiles: PersonProfile[] = parsed.profiles.map((profile) => ({
    personId: profile.personId,
    displayName: profile.displayName,
    role: profile.role,
    ...(profile.accountIds ? { accountIds: profile.accountIds } : {}),
    ...(profile.speakerProfileId ? { speakerProfileId: profile.speakerProfileId } : {}),
    ...(profile.speakerEnabled !== undefined ? { speakerEnabled: profile.speakerEnabled } : {}),
    ...(profile.relationships ? { relationships: profile.relationships } : {})
  }));

  return new PersonDirectory(profiles, {
    ...(parsed.guestPersonId ? { guestPersonId: parsed.guestPersonId } : {})
  });
}
