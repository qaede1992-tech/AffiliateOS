import { eq } from "drizzle-orm";
import type { OAuthStateRepository } from "../domain/oauth.js";
import type { OAuthState } from "../domain/oauth.js";
import { oauthStates } from "./schema.js";

type DatabaseExecutor = any;

export class DrizzleOAuthStateRepository implements OAuthStateRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async save(state: OAuthState): Promise<OAuthState> {
    await this.db.insert(oauthStates).values(state).onConflictDoUpdate({
      target: oauthStates.state,
      set: { platform: state.platform, redirectUri: state.redirectUri, expiresAt: state.expiresAt }
    });
    return state;
  }

  async findByState(state: string): Promise<OAuthState | undefined> {
    const rows = await this.db.select().from(oauthStates).where(eq(oauthStates.state, state)).limit(1);
    return rows[0];
  }

  async remove(state: string): Promise<void> {
    await this.db.delete(oauthStates).where(eq(oauthStates.state, state));
  }
}
