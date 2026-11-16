import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { createSessionToken, verifySessionToken, type SessionClaims } from '../src/session.js';
import { openDb } from '../src/db.js';
import { UsersService } from '../src/services/users.js';

/**
 * This module decides who is signed in, so it is covered directly rather than
 * only through HTTP calls that happen to present a valid token. Every "refuses"
 * case below is a way an attacker or a stale client could otherwise be accepted.
 */
const SECRET = 'unit-test-session-secret-0123456789abcdef';

/** Rebuilds a token the way an earlier release did, to pin backwards compatibility. */
function mintLegacy(userId: number, secondsToLive: number): string {
  const payload = { uid: userId, exp: Math.floor(Date.now() / 1000) + secondsToLive };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function signWith(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

describe('session tokens', () => {
  it('round-trips the user id and the session generation', () => {
    const claims = verifySessionToken(SECRET, createSessionToken(SECRET, 42, 3600, 5));
    expect(claims).toEqual<SessionClaims>({ uid: 42, epoch: 5 });
  });

  it('refuses a token past its expiry', () => {
    expect(verifySessionToken(SECRET, createSessionToken(SECRET, 1, -1))).toBeNull();
    // And accepts one that is still alive, so the check is about the boundary.
    expect(verifySessionToken(SECRET, createSessionToken(SECRET, 1, 3600))?.uid).toBe(1);
  });

  it('refuses a token signed by anyone else', () => {
    const token = createSessionToken(SECRET, 1, 3600);
    expect(verifySessionToken('a-different-secret-entirely-0123456789', token)).toBeNull();
  });

  it('refuses a tampered body even when re-signatured with the original signature', () => {
    const token = createSessionToken(SECRET, 1, 3600);
    const [body, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ uid: 999, epoch: 0, exp: 2 ** 40 }))
      .toString('base64url');
    expect(verifySessionToken(SECRET, `${forged}.${signature}`)).toBeNull();
    expect(verifySessionToken(SECRET, `${body}.`)).toBeNull();
    expect(verifySessionToken(SECRET, `${body}${signature}`)).toBeNull();
  });

  it('refuses a signature recomputed with the secret of another user of the endpoint', () => {
    // Proves the signature is what is trusted, not the JSON shape: a valid
    // signature over a body the server never minted must still be accepted only
    // when it was produced with this secret.
    const body = Buffer.from(JSON.stringify({ uid: 1, epoch: 0, exp: 2 ** 40 })).toString('base64url');
    expect(verifySessionToken(SECRET, `${body}.${signWith(SECRET, body)}`)?.uid).toBe(1);
    expect(verifySessionToken(SECRET, `${body}.${signWith('other-secret-0123456789abcdef', body)}`)).toBeNull();
  });

  it('refuses malformed input rather than throwing', () => {
    for (const value of [undefined, '', '.', 'a.b', '....', '!!!.***', 'null.null']) {
      expect(verifySessionToken(SECRET, value)).toBeNull();
    }
    // A body that is valid base64url but not JSON, and JSON with the wrong types.
    const notJson = Buffer.from('not json at all').toString('base64url');
    expect(verifySessionToken(SECRET, `${notJson}.${signWith(SECRET, notJson)}`)).toBeNull();
    const wrongTypes = Buffer.from(JSON.stringify({ uid: 'one', exp: 2 ** 40 })).toString('base64url');
    expect(verifySessionToken(SECRET, `${wrongTypes}.${signWith(SECRET, wrongTypes)}`)).toBeNull();
    const noUid = Buffer.from(JSON.stringify({ exp: 2 ** 40 })).toString('base64url');
    expect(verifySessionToken(SECRET, `${noUid}.${signWith(SECRET, noUid)}`)).toBeNull();
    const noExp = Buffer.from(JSON.stringify({ uid: 1, epoch: 0 })).toString('base64url');
    expect(verifySessionToken(SECRET, `${noExp}.${signWith(SECRET, noExp)}`)).toBeNull();
  });

  it('reads an absent or null generation as zero, matching a legacy token', () => {
    // Signed with the real secret, so it is trusted; only the epoch is missing.
    for (const body of [
      Buffer.from(JSON.stringify({ uid: 3, exp: 2 ** 40 })).toString('base64url'),
      Buffer.from(JSON.stringify({ uid: 3, exp: 2 ** 40, epoch: null })).toString('base64url'),
    ]) {
      expect(verifySessionToken(SECRET, `${body}.${signWith(SECRET, body)}`))
        .toEqual<SessionClaims>({ uid: 3, epoch: 0 });
    }
  });

  it('refuses to verify anything when no secret is configured', () => {
    expect(verifySessionToken('', createSessionToken(SECRET, 1, 3600))).toBeNull();
  });

  it('treats a token minted before generations existed as generation zero', () => {
    expect(verifySessionToken(SECRET, mintLegacy(7, 3600))).toEqual<SessionClaims>({ uid: 7, epoch: 0 });
  });
});

describe('revocation', () => {
  function userService() {
    const db = openDb(':memory:');
    return { db, users: new UsersService(db) };
  }

  it('accepts the current generation and refuses every other one', () => {
    const { db, users } = userService();
    const { user } = users.upsertFromProfile({
      provider: 'google',
      provider_user_id: 'g-1',
      email: 'ada@example.com',
      display_name: 'Ada',
      avatar_url: null,
    });
    expect(user.session_epoch).toBe(0);

    expect(users.findByClaims({ uid: user.id, epoch: 0 })?.id).toBe(user.id);

    users.revokeSessions(user.id);
    const after = users.findById(user.id);
    expect(after?.session_epoch).toBe(1);

    // The token the browser held before the logout is now worthless...
    expect(users.findByClaims({ uid: user.id, epoch: 0 })).toBeNull();
    // ...while one minted in the new generation works, immediately.
    expect(users.findByClaims({ uid: user.id, epoch: 1 })?.id).toBe(user.id);

    // Repeated logouts keep advancing it; nothing wraps or stalls.
    users.revokeSessions(user.id);
    expect(users.findByClaims({ uid: user.id, epoch: 1 })).toBeNull();
    expect(users.findByClaims({ uid: user.id, epoch: 2 })?.id).toBe(user.id);
    db.close();
  });

  it('refuses claims for a user who is not there', () => {
    const { db, users } = userService();
    expect(users.findByClaims({ uid: 4242, epoch: 0 })).toBeNull();
    db.close();
  });

  it('revokes one account without disturbing another', () => {
    const { db, users } = userService();
    const profile = (id: string) => ({
      provider: 'github' as const,
      provider_user_id: id,
      email: null,
      display_name: id,
      avatar_url: null,
    });
    const ada = users.upsertFromProfile(profile('ada')).user;
    const bob = users.upsertFromProfile(profile('bob')).user;

    users.revokeSessions(ada.id);
    expect(users.findByClaims({ uid: ada.id, epoch: 0 })).toBeNull();
    expect(users.findByClaims({ uid: bob.id, epoch: 0 })?.id).toBe(bob.id);
    db.close();
  });
});
