import { and, eq, lt } from "drizzle-orm";
import type { OAuthStateRepository, OAuthState } from "../domain/oauth.js";
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
  async consume(state: string, platform: string): Promise<OAuthState | undefined> {
    const rows = await this.db.delete(oauthStates)
      .where(and(eq(oauthStates.state, state), eq(oauthStates.platform, platform)))
      .returning();
    return rows[0];
  }
  async deleteExpired(before: string): Promise<void> {
    await this.db.delete(oauthStates).where(lt(oauthStates.expiresAt, before));
  }
}
