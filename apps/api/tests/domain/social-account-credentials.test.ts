import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySocialAccountRepository } from "../../src/domain/repository.js";
import { SocialAccountService } from "../../src/domain/content.js";

test("social credential revocation removes the opaque reference and deactivates the account", async () => {
  const account = { id: "account-1", platform: "instagram", accountReference: "creator-1", status: "active" as const, connection: { accessToken: "secret" }, credentialReference: "vault://social/1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const repository = new InMemorySocialAccountRepository();
  await repository.save(account);
  const service = new SocialAccountService(repository);

  const revoked = await service.revokeCredential(account.id);
  assert.equal(revoked.status, "inactive");
  assert.equal(revoked.hasCredentialReference, false);
  assert.equal("credentialReference" in revoked, false);
  assert.equal(revoked.connection.accessToken, "[REDACTED]");

  const stored = await repository.findById(account.id);
  assert.equal(stored?.credentialReference, undefined);
  assert.equal(stored?.status, "inactive");
});

test("revoking an already credential-less account is idempotent", async () => {
  const account = { id: "account-2", platform: "x", accountReference: "creator-2", status: "inactive" as const, connection: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const repository = new InMemorySocialAccountRepository();
  await repository.save(account);
  const service = new SocialAccountService(repository);

  const result = await service.revokeCredential(account.id);
  assert.equal(result.status, "inactive");
  assert.equal(result.hasCredentialReference, false);
});


test("social account creation rejects raw credential values", async () => {
  const repository = new InMemorySocialAccountRepository();
  const service = new SocialAccountService(repository);
  await assert.rejects(
    () => service.create({
      platform: "instagram",
      accountReference: "creator-raw",
      credentialReference: "raw-access-token"
    }),
    (error: unknown) => error instanceof Error && error.message === "Social credential references must be opaque secret-manager references."
  );
});

test("social credential rotation requires an opaque reference", async () => {
  const account = { id: "account-3", platform: "facebook", accountReference: "creator-3", status: "active" as const, connection: {}, credentialReference: "vault://social/3", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const repository = new InMemorySocialAccountRepository();
  await repository.save(account);
  const service = new SocialAccountService(repository);
  await assert.rejects(
    () => service.rotateCredential(account.id, "plain-token"),
    (error: unknown) => error instanceof Error && error.message === "Social credential references must be opaque secret-manager references."
  );
});
