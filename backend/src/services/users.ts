import type { Db, UserRow } from '../db.js';
import type { OAuthProfile } from '../oauth.js';
import type { SessionClaims } from '../session.js';
import type { ApiUser } from '../types.js';

export class UsersService {
  constructor(private readonly db: Db) {}

  findById(id: number): UserRow | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ?? null;
  }

  /**
   * Resolves a verified token to its user, honouring revocation: the token must
   * carry the user's current session generation. This is what makes logout
   * revoke a session rather than merely asking the browser to forget it — a
   * copied or replayed token from before the logout is worth nothing.
   */
  findByClaims(claims: SessionClaims): UserRow | null {
    const user = this.findById(claims.uid);
    if (!user) return null;
    if (claims.epoch !== user.session_epoch) return null;
    return user;
  }

  /**
   * Ends every session issued so far for this user by moving to the next
   * generation. Counting rather than timestamping means there is no boundary
   * case: signing in again immediately mints a token in the new generation and
   * works, while everything from the old one stays dead.
   */
  revokeSessions(userId: number): void {
    this.db
      .prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?')
      .run(userId);
  }

  /**
   * Creates the local user record on first successful SSO sign-in, otherwise
   * refreshes the profile data the provider returned. Identity is keyed on
   * (provider, provider_user_id) because GitHub may not expose an email.
   */
  upsertFromProfile(profile: OAuthProfile): { user: UserRow; created: boolean } {
    const existing = this.db
      .prepare('SELECT * FROM users WHERE provider = ? AND provider_user_id = ?')
      .get(profile.provider, profile.provider_user_id) as UserRow | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE users
             SET email = COALESCE(?, email),
                 display_name = ?,
                 avatar_url = COALESCE(?, avatar_url),
                 last_login_at = datetime('now')
           WHERE id = ?`,
        )
        .run(profile.email, profile.display_name, profile.avatar_url, existing.id);
      const updated = this.findById(existing.id);
      if (!updated) throw new Error('user disappeared during update');
      return { user: updated, created: false };
    }

    const info = this.db
      .prepare(
        `INSERT INTO users (provider, provider_user_id, email, display_name, avatar_url)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        profile.provider,
        profile.provider_user_id,
        profile.email,
        profile.display_name,
        profile.avatar_url,
      );
    const user = this.findById(Number(info.lastInsertRowid));
    if (!user) throw new Error('failed to create user record');
    return { user, created: true };
  }

  static toApi(user: UserRow): ApiUser {
    return {
      id: user.id,
      provider: user.provider,
      email: user.email,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      created_at: user.created_at,
    };
  }
}
