import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SocialCredentialStore } from "./social-credentials.js";

type EncryptedCredentialFile = {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

const VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MIN_KEY_LENGTH = 32;

export class EncryptedFileSocialCredentialStore implements SocialCredentialStore {
  private writeQueue = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly encryptionKey: Buffer
  ) {
    if (!filePath.trim()) throw new Error("Social credential store path is required.");
    if (encryptionKey.length < MIN_KEY_LENGTH) {
      throw new Error("Social credential store key must be at least 32 bytes.");
    }
  }

  static fromSecret(filePath: string, secret: string): EncryptedFileSocialCredentialStore {
    const value = secret.trim();
    if (Buffer.byteLength(value, "utf8") < MIN_KEY_LENGTH) {
      throw new Error("SOCIAL_CREDENTIAL_STORE_KEY must be at least 32 characters.");
    }
    const key = createHash("sha256").update(value, "utf8").digest();
    return new EncryptedFileSocialCredentialStore(filePath, key);
  }

  async store(credentialReference: string, credential: unknown): Promise<void> {
    const reference = credentialReference.trim();
    if (!reference) throw new Error("Social credential reference is required.");

    this.writeQueue = this.writeQueue.then(async () => {
      const credentials = await this.readCredentials();
      credentials[reference] = credential;
      await this.writeCredentials(credentials);
    });
    return this.writeQueue;
  }

  async resolve(credentialReference: string): Promise<unknown> {
    const reference = credentialReference.trim();
    if (!reference) throw new Error("Social credential reference is required.");
    const credentials = await this.readCredentials();
    if (!(reference in credentials)) throw new Error("Social credential was not found.");
    return credentials[reference];
  }

  async delete(credentialReference: string): Promise<void> {
    const reference = credentialReference.trim();
    if (!reference) return;
    this.writeQueue = this.writeQueue.then(async () => {
      const credentials = await this.readCredentials();
      if (!(reference in credentials)) return;
      delete credentials[reference];
      await this.writeCredentials(credentials);
    });
    return this.writeQueue;
  }

  private async readCredentials(): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const envelope = JSON.parse(raw) as Partial<EncryptedCredentialFile>;
      if (
        envelope.version !== VERSION ||
        typeof envelope.iv !== "string" ||
        typeof envelope.tag !== "string" ||
        typeof envelope.ciphertext !== "string"
      ) {
        throw new Error("Invalid social credential store format.");
      }

      const iv = Buffer.from(envelope.iv, "base64");
      const tag = Buffer.from(envelope.tag, "base64");
      const ciphertext = Buffer.from(envelope.ciphertext, "base64");
      if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH || ciphertext.length === 0) {
        throw new Error("Invalid social credential store payload.");
      }

      const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      const parsed = JSON.parse(plaintext) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid social credential store data.");
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return {};
      if (error instanceof SyntaxError) throw new Error("Social credential store contains invalid JSON.");
      throw new Error("Unable to read social credential store.");
    }
  }

  private async writeCredentials(credentials: Record<string, unknown>): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv);
    const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: EncryptedCredentialFile = {
      version: VERSION,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath).catch(async (error) => {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    });
  }
}
