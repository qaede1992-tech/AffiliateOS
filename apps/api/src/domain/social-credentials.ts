export interface SocialCredentialResolver {
  resolve(credentialReference: string): Promise<unknown>;
}

/**
 * Explicitly fails when a publisher tries to use a credential reference without
 * a configured secret resolver. This keeps credential material out of domain
 * account records and prevents accidental use of the reference as a secret.
 */
export class UnconfiguredSocialCredentialResolver implements SocialCredentialResolver {
  async resolve(_credentialReference: string): Promise<never> {
    throw new Error("Social credential resolution is not configured.");
  }
}

export class InMemorySocialCredentialResolver implements SocialCredentialResolver {
  constructor(private readonly credentials = new Map<string, unknown>()) {}

  set(reference: string, credential: unknown): void {
    this.credentials.set(reference, credential);
  }

  async resolve(credentialReference: string): Promise<unknown> {
    if (!this.credentials.has(credentialReference)) {
      throw new Error("Social credential was not found.");
    }
    return this.credentials.get(credentialReference);
  }
}
