export type PasskeyDeploymentSecurityInput = {
  production: boolean;
  rpId?: string;
  origins: string[];
};

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

export function validatePasskeyDeploymentSecurity(
  input: PasskeyDeploymentSecurityInput
): void {
  if (!input.production || !input.rpId) return;

  if (isLoopbackHost(input.rpId)) {
    throw new Error(
      "Production passkey RP ID must not use localhost/loopback"
    );
  }

  for (const origin of input.origins) {
    const url = new URL(origin);
    if (url.protocol !== "https:") {
      throw new Error(
        "Production passkey origins must use HTTPS"
      );
    }
    if (isLoopbackHost(url.hostname)) {
      throw new Error(
        "Production passkey origins must not use localhost/loopback"
      );
    }
  }
}
