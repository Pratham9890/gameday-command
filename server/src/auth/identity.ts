import type { Position } from '../types.ts';
import type { UserRow, Users } from './users.ts';
import { burnVerify, type ScryptParams, verifyPassword } from './password.ts';

/**
 * Where identities come from. Local accounts now; agency single sign-on later
 * through the same interface (PLT-07). A provider only answers "who is this";
 * positions always come from grants held in this server, optionally seeded
 * from IdP groups through `groupMap`.
 */
export interface IdentityProvider {
  readonly id: string;
  readonly kind: 'local' | 'oidc' | 'saml';
  readonly label: string;
  /** Whether sign-in through this provider is available right now. */
  readonly enabled: boolean;
}

/** Username and password, checked against scrypt hashes in `users`. */
export interface PasswordProvider extends IdentityProvider {
  kind: 'local';
  verify(username: string, password: string): Promise<{ user: UserRow; needsRehash: boolean } | null>;
}

/** A redirect-based provider (OIDC authorization code with PKCE, or SAML 2.0 POST). */
export interface RedirectProvider extends IdentityProvider {
  kind: 'oidc' | 'saml';
  /** Build the redirect to the IdP; the returned state is kept server-side for the callback. */
  begin(returnTo: string): Promise<{ redirectUrl: string; state: string }>;
  /** Validate the IdP's response and map it to an account (created on first sign-in if allowed). */
  complete(params: URLSearchParams, state: string): Promise<{ user: UserRow; groups: string[] }>;
  /** IdP group → position grants to apply on sign-in. */
  readonly groupMap: Record<string, { position: Position; scope: string }[]>;
}

export class LocalPasswordProvider implements PasswordProvider {
  readonly id = 'local';
  readonly kind = 'local' as const;
  readonly label = 'Gameday Command account';
  readonly enabled = true;

  private readonly users: Users;
  private readonly policy: ScryptParams;
  constructor(
    users: Users,
    policy: ScryptParams,
  ) {
    this.users = users;
    this.policy = policy;
  }

  async verify(username: string, password: string): Promise<{ user: UserRow; needsRehash: boolean } | null> {
    const user = this.users.byUsername(username);
    if (!user || !user.password_hash || user.idp !== 'local') {
      await burnVerify(password, this.policy);
      return null;
    }
    const result = await verifyPassword(password, user.password_hash, this.policy);
    return result.ok ? { user, needsRehash: result.needsRehash } : null;
  }
}

/**
 * OpenID Connect, documented and not yet wired. The intended implementation:
 *
 * 1. Configuration: `GAMEDAY_OIDC_ISSUER`, `GAMEDAY_OIDC_CLIENT_ID`,
 *    `GAMEDAY_OIDC_CLIENT_SECRET` (server-side only), `GAMEDAY_OIDC_REDIRECT_URI`,
 *    and `GAMEDAY_OIDC_GROUPS` mapping IdP groups to positions.
 * 2. Discovery from `<issuer>/.well-known/openid-configuration`, fetched through
 *    the outbound allowlist (the issuer host must be on it).
 * 3. `begin`: authorization code flow with PKCE (S256), a random `state` and
 *    `nonce` kept server-side for five minutes.
 * 4. `complete`: exchange the code at the token endpoint, validate the ID token
 *    (issuer, audience, expiry, nonce, signature against the JWKS), take `sub`
 *    as the stable subject, and map `groups` to grants.
 * 5. The session is then issued exactly as for a local sign-in; MFA is the
 *    IdP's job (require `acr`/`amr` showing two factors).
 *
 * `openid-client` (MIT, by panva) is the library to use when this is built;
 * it is not a dependency yet. Record it in docs/licences/WS3.md when added.
 */
export class OidcProviderStub implements RedirectProvider {
  readonly kind = 'oidc' as const;
  readonly enabled = false;
  readonly groupMap: Record<string, { position: Position; scope: string }[]> = {};

  readonly id: string;
  readonly label: string;
  constructor(
    id: string = 'oidc',
    label: string = 'Agency single sign-on (OpenID Connect)',
  ) {
    this.id = id;
    this.label = label;
  }

  async begin(): Promise<{ redirectUrl: string; state: string }> {
    throw new IdentityNotConfigured(this.id);
  }

  async complete(): Promise<{ user: UserRow; groups: string[] }> {
    throw new IdentityNotConfigured(this.id);
  }
}

export class IdentityNotConfigured extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(`identity provider ${providerId} is not configured on this server`);
    this.providerId = providerId;
  }
}

export class IdentityRegistry {
  private readonly providers = new Map<string, IdentityProvider>();

  register(provider: IdentityProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): IdentityProvider | undefined {
    return this.providers.get(id);
  }

  password(): PasswordProvider {
    return this.providers.get('local') as PasswordProvider;
  }

  list(): { id: string; kind: string; label: string; enabled: boolean }[] {
    return [...this.providers.values()].map(({ id, kind, label, enabled }) => ({ id, kind, label, enabled }));
  }
}
