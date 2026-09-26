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


/**
 * Resolves opaque social credential references from a deployment-injected JSON
 * secret. The JSON value should be supplied by the deployment secret manager;
 * no credential material belongs in source control or database records.
 */
export class JsonSocialCredentialResolver implements SocialCredentialResolver {
  constructor(private readonly credentials: Record<string, unknown>) {}

  static fromJson(value: string): JsonSocialCredentialResolver {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("SOCIAL_CREDENTIALS_JSON must contain valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("SOCIAL_CREDENTIALS_JSON must contain a JSON object.");
    }
    return new JsonSocialCredentialResolver(parsed as Record<string, unknown>);
  }

  async resolve(credentialReference: string): Promise<unknown> {
    if (!credentialReference.trim()) throw new Error("Social credential reference is required.");
    if (!(credentialReference in this.credentials)) {
      throw new Error("Social credential was not found.");
    }
    return this.credentials[credentialReference];
  }
}
