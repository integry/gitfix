import { Octokit } from '@octokit/core';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import { loadMonitoredReposRaw } from '@propr/core';
import type { GitHubUser } from '../authTypes.js';
import { resolveInstanceAuthorization, type InstanceAuthorization, type InstancePermission } from '../authorization.js';
import { isUserWhitelisted } from '../userWhitelist.js';
import { refreshStoredGitHubCredential } from '../authGithubTokens.js';
import { redeemConnectAuthorizationCode } from '../connectAuth.js';
import { McpError, MCP_SCOPES, type McpConfig, type McpScope } from './config.js';
import { McpOAuthProvider, type McpGrant } from './oauth.js';
import { secret } from './store.js';

export interface McpPrincipal {
  user: GitHubUser;
  authorization: InstanceAuthorization;
  grant: McpGrant;
  scopes: McpScope[];
  github: Octokit;
}

export class McpPolicy {
  private readonly jwks;
  constructor(readonly oauth: McpOAuthProvider, readonly config: McpConfig) {
    this.jwks = config.connect ? createRemoteJWKSet(new URL(config.connect.jwks), { timeoutDuration: 5000, cooldownDuration: 30_000 }) : undefined;
  }

  async authenticate(bearer: string): Promise<McpPrincipal> {
    let grant: McpGrant;
    let scopes: McpScope[];
    if (bearer.startsWith('propr_mcp_')) {
      const info = await this.oauth.verifyAccessToken(bearer);
      grant = await this.oauth.grant(info.extra.grantId);
      scopes = info.scopes;
    } else {
      try { grant = await this.delegation(bearer); }
      catch (error) {
        if (error instanceof McpError) throw error;
        if (error instanceof joseErrors.JWKSTimeout || !(error instanceof joseErrors.JOSEError)) throw new McpError('CONNECT_UNAVAILABLE', 'Connect grant validation is unavailable.', 503);
        throw new McpError('INVALID_DELEGATION', 'Connect signature or token claims are invalid.', 401);
      }
      scopes = grant.scopes;
    }
    let user = await this.oauth.store.get<GitHubUser>('credential', grant.ownerId);
    if (!user?.accessToken) throw new McpError('GITHUB_CREDENTIAL_REQUIRED', 'Sign in through the browser to authorize GitHub access.', 401);
    if (user.tokenExpiresAt && user.tokenExpiresAt < Date.now() + 30_000) {
      user = await this.refreshCredential(user);
    }
    const github = new Octokit({ auth: user.accessToken, request: { timeout: 10_000 } });
    let identity;
    try { identity = (await github.request('GET /user')).data; }
    catch { throw new McpError('GITHUB_CREDENTIAL_REQUIRED', 'GitHub authorization is unavailable; sign in again.', 401); }
    if (String(identity.id) !== grant.ownerId || !isUserWhitelisted(identity.login)) throw new McpError('ACCESS_REVOKED', 'Current instance access denied.', 403);
    user = { ...user, username: identity.login, login: identity.login };
    const authorization = await resolveInstanceAuthorization(user, this.oauth.store.db);
    if (authorization.source === 'demo' || (['local', 'managed'].includes(grant.membershipSource) && authorization.source === 'implicit')) {
      throw new McpError('ACCESS_REVOKED', 'Instance membership was revoked.', 403);
    }
    return { user, authorization, grant, scopes, github };
  }

  private async refreshCredential(user: GitHubUser): Promise<GitHubUser> {
    const store = this.oauth.store;
    const identity = { kind: 'credential_refresh', id: user.id };
    const value = store.seal({ nonce: secret() });
    const claim = await store.db('mcp_records').insert({ ...identity, value, expires_at: Date.now() + 90_000 })
      .onConflict(['kind', 'id']).merge().where('mcp_records.expires_at', '<', Date.now()).returning('id');
    if (!claim.length) throw new McpError('GITHUB_AUTH_REFRESHING', 'GitHub authorization is refreshing. Retry in three seconds.', 503);
    try {
      const current = await store.get<GitHubUser>('credential', user.id);
      if (!current?.accessToken) throw new McpError('GITHUB_CREDENTIAL_REQUIRED', 'GitHub credential unavailable.', 401);
      if (!current.tokenExpiresAt || current.tokenExpiresAt >= Date.now() + 30_000) return current;
      const originalToken = current.accessToken;
      const result = await refreshStoredGitHubCredential(current);
      if (result.status === 'temporarily-unavailable') throw new McpError('GITHUB_UNAVAILABLE', 'GitHub authorization refresh is temporarily unavailable.', 503);
      if (result.status !== 'refreshed') throw new McpError('GITHUB_CREDENTIAL_REQUIRED', 'GitHub authorization must be renewed in the browser.', 401);
      // Do not hold a SQLite transaction during the shared refresh coordinator
      // or overwrite a newer browser consent that completed in the meantime.
      return await store.db.transaction(async tx => {
        const latest = await store.get<GitHubUser>('credential', user.id, tx);
        if (latest?.accessToken !== originalToken) return latest || current;
        await store.put('credential', user.id, current, undefined, tx);
        return current;
      });
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError('GITHUB_UNAVAILABLE', 'GitHub authorization refresh is temporarily unavailable.', 503);
    } finally { await store.db('mcp_records').where({ ...identity, value }).delete(); }
  }

  private async delegation(token: string): Promise<McpGrant> {
    const connect = this.config.connect;
    if (!connect || !this.jwks) throw new McpError('INVALID_TOKEN', 'Connect trust is disabled.', 401);
    const { payload, protectedHeader } = await jwtVerify(token, this.jwks, {
      algorithms: ['ES256'], issuer: connect.issuer, audience: `urn:propr:instance:${this.config.instanceId}`,
      clockTolerance: 5, maxTokenAge: '65s', requiredClaims: ['sub', 'iat', 'exp', 'jti', 'grant_id', 'instance_id', 'installation_id', 'scope', 'repositories', 'contract_version'],
    });
    if (payload.contract_version !== 1) throw new McpError('INSTANCE_VERSION_MISMATCH', 'This instance does not support the signed Connect contract version.', 409);
    if (protectedHeader.typ !== 'propr-mcp-delegation+jwt'
      || payload.aud !== `urn:propr:instance:${this.config.instanceId}` || typeof protectedHeader.kid !== 'string'
      || payload.instance_id !== this.config.instanceId || payload.installation_id !== connect.installationId
      || !/^\d+$/.test(payload.sub || '') || typeof payload.grant_id !== 'string'
      || payload.exp! <= payload.iat! || payload.exp! - payload.iat! > 60 || payload.iat! > Date.now() / 1000 + 5
      || typeof payload.scope !== 'string' || !Array.isArray(payload.repositories)
      || payload.repositories.length > 100 || payload.repositories.some(repo => typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo))) {
      throw new McpError('INVALID_DELEGATION', 'Invalid Connect delegation binding.', 401);
    }
    const scopes = payload.scope.split(' ') as McpScope[];
    if (scopes.some(scope => !MCP_SCOPES.includes(scope))) throw new McpError('INVALID_DELEGATION', 'Unknown delegation scope.', 401);
    // No positive cache: revocation and membership changes apply to every call.
    const response = await fetch(connect.introspection, {
      method: 'POST', headers: { Authorization: `Bearer ${connect.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_id: payload.grant_id, subject: payload.sub, instance_id: this.config.instanceId, installation_id: connect.installationId }),
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) throw new McpError('CONNECT_UNAVAILABLE', 'Connect grant validation is unavailable.', 503);
    const state = await response.json() as Record<string, unknown>;
    if (state.active !== true || state.grant_id !== payload.grant_id || state.subject !== payload.sub
      || state.instance_id !== payload.instance_id || state.installation_id !== payload.installation_id) throw new McpError('ACCESS_REVOKED', 'Connect grant or membership revoked.', 403);
    if (typeof state.scope !== 'string' || !Array.isArray(state.repositories)) throw new McpError('INVALID_DELEGATION', 'Connect introspection omitted current grant restrictions.', 401);
    const currentScopes = state.scope.split(' ');
    const effectiveScopes = scopes.filter(scope => currentScopes.includes(scope));
    const effectiveRepositories = (payload.repositories as string[]).filter(repo => (state.repositories as unknown[]).includes(repo));
    if (!await this.oauth.store.get('credential', payload.sub!) && typeof state.credential_grant === 'string') {
      const user = await redeemConnectAuthorizationCode({ code: state.credential_grant, relayUrl: process.env.PROPR_GH_RELAY_URL!, relayToken: process.env.PROPR_GH_RELAY_TOKEN! });
      if (user.id !== payload.sub) throw new McpError('INVALID_DELEGATION', 'Credential owner does not match delegation.', 401);
      await this.oauth.store.put('credential', user.id, user);
    }
    return { id: payload.grant_id, ownerId: payload.sub!, clientId: 'connect', clientName: 'ProPR Connect',
      instanceId: this.config.instanceId, resource: this.config.resource, scopes: effectiveScopes, repositories: effectiveRepositories,
      createdAt: payload.iat! * 1000, expiresAt: payload.exp! * 1000, revoked: false, membershipSource: 'connect' };
  }

  requireScope(principal: McpPrincipal, scope: McpScope): void {
    if (!principal.scopes.includes(scope)) throw new McpError('INSUFFICIENT_SCOPE', `This operation requires ${scope}.`, 403);
  }

  requirePermission(principal: McpPrincipal, permission: InstancePermission): void {
    if (!principal.authorization.permissions.includes(permission)) throw new McpError('INSUFFICIENT_INSTANCE_PERMISSION', `This operation requires ${permission}.`, 403);
  }

  async repository(principal: McpPrincipal, repository: string, write = false, includeDisabled = false): Promise<void> {
    const configured = (await loadMonitoredReposRaw()).some(repo => (repo.enabled || includeDisabled) && repo.name.toLowerCase() === repository.toLowerCase());
    if (!configured || !principal.grant.repositories.some(repo => repo.toLowerCase() === repository.toLowerCase())) throw new McpError('REPOSITORY_FORBIDDEN', 'Repository is outside this grant or current instance configuration.', 403);
    const [owner, repo] = repository.split('/');
    let data;
    try { data = (await principal.github.request('GET /repos/{owner}/{repo}', { owner, repo })).data; }
    catch { throw new McpError('REPOSITORY_FORBIDDEN', 'Current GitHub repository access denied.', 403); }
    if (write && data.permissions?.push !== true && data.permissions?.admin !== true) throw new McpError('REPOSITORY_FORBIDDEN', 'Current GitHub write permission required.', 403);
  }
}
