import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '@propr/core';
import type { GitHubUser } from './authTypes.js';

const ENCRYPTION_CONTEXT = 'propr:github-user-grant:v1';
const REFRESH_BUFFER_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 20_000;
const USER_TOKEN_PATTERN = /^(?:gho_|ghu_|ghp_|github_pat_)/;

interface GrantRow {
  github_user_id: string;
  github_username: string;
  source: 'github' | 'connect';
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  access_token_expires_at_ms: number | string | null;
  refresh_token_expires_at_ms: number | string | null;
  status: 'active' | 'reauth_required';
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface RefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
}

export type GitHubUserGrantResolution =
  | { status: 'active'; accessToken: string }
  | { status: 'missing' }
  | { status: 'reauth_required' }
  | { status: 'temporarily_unavailable' };

function encryptionKey(environment: NodeJS.ProcessEnv): Buffer {
  const secret = environment.PROPR_CREDENTIAL_ENCRYPTION_KEY?.trim()
    || environment.SYSTEM_TASK_SECRET?.trim()
    || environment.SESSION_SECRET?.trim();
  if (!secret) throw new Error('A credential encryption secret is required to store GitHub user grants');
  return createHash('sha256').update(ENCRYPTION_CONTEXT).update('\0').update(secret).digest();
}

function encryptToken(token: string, environment: NodeJS.ProcessEnv): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(environment), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptToken(value: string, environment: NodeJS.ProcessEnv): string {
  const [version, encodedIv, encodedTag, encodedValue] = value.split('.');
  if (version !== 'v1' || !encodedIv || !encodedTag || !encodedValue) throw new Error('Invalid GitHub user grant envelope');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(environment), Buffer.from(encodedIv, 'base64url'));
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function timestamp(value: number | string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isUnrecoverableRefreshError(error?: string): boolean {
  return error === 'bad_refresh_token' || error === 'invalid_grant';
}

function assertUserToken(token: string): string {
  const normalized = token.trim();
  if (!USER_TOKEN_PATTERN.test(normalized)) throw new Error('GitHub user grant did not contain a supported user token');
  return normalized;
}

export class GitHubUserGrantService {
  private readonly refreshes = new Map<string, Promise<'refreshed' | 'reauth_required' | 'temporarily_unavailable'>>();

  constructor(
    private readonly database: Knex = db,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async capture(user: GitHubUser): Promise<boolean> {
    if (!user.accessToken || !user.oauthSource) return false;
    if (!await this.database.schema.hasTable('github_user_grants')) return false;
    const accessToken = assertUserToken(user.accessToken);
    const values = {
      github_user_id: user.id,
      github_username: user.username,
      source: user.oauthSource,
      access_token_encrypted: encryptToken(accessToken, this.environment),
      refresh_token_encrypted: user.refreshToken
        ? encryptToken(user.refreshToken.trim(), this.environment)
        : null,
      access_token_expires_at_ms: user.tokenExpiresAt ?? null,
      refresh_token_expires_at_ms: user.refreshTokenExpiresAt ?? null,
      status: 'active' as const,
      last_error_code: null,
      updated_at: this.database.fn.now(),
    };
    await this.database('github_user_grants')
      .insert({ ...values, created_at: this.database.fn.now() })
      .onConflict('github_user_id')
      .merge(values);
    return true;
  }

  async updateIfOwner(user: GitHubUser): Promise<boolean> {
    if (!await this.database.schema.hasTable('github_user_grants')) return false;
    const existing = await this.database<GrantRow>('github_user_grants')
      .where({ github_user_id: user.id })
      .first();
    if (!existing) return false;
    return this.capture(user);
  }

  async resolve(githubUserId: string, forceRefresh = false): Promise<GitHubUserGrantResolution> {
    let row = await this.database<GrantRow>('github_user_grants')
      .where({ github_user_id: githubUserId })
      .first();
    if (!row) return { status: 'missing' };
    if (row.status !== 'active') return { status: 'reauth_required' };

    const expiresAt = timestamp(row.access_token_expires_at_ms);
    const needsRefresh = forceRefresh || (expiresAt !== undefined && expiresAt - Date.now() < REFRESH_BUFFER_MS);
    if (needsRefresh) {
      if (!row.refresh_token_encrypted) {
        await this.markReauthRequired(githubUserId, 'missing_refresh_token');
        return { status: 'reauth_required' };
      }
      const refreshed = await this.refreshOnce(row);
      if (refreshed !== 'refreshed') return { status: refreshed };
      row = await this.database<GrantRow>('github_user_grants')
        .where({ github_user_id: githubUserId })
        .first();
      if (!row || row.status !== 'active') return { status: 'reauth_required' };
    }

    try {
      return { status: 'active', accessToken: assertUserToken(decryptToken(row.access_token_encrypted, this.environment)) };
    } catch (error) {
      await this.markReauthRequired(githubUserId, 'decryption_failed');
      console.error('Could not decrypt GitHub user grant:', error);
      return { status: 'reauth_required' };
    }
  }

  private async refreshOnce(row: GrantRow): Promise<'refreshed' | 'reauth_required' | 'temporarily_unavailable'> {
    const existing = this.refreshes.get(row.github_user_id);
    if (existing) return existing;
    const pending = this.refresh(row).finally(() => this.refreshes.delete(row.github_user_id));
    this.refreshes.set(row.github_user_id, pending);
    return pending;
  }

  private async refresh(row: GrantRow): Promise<'refreshed' | 'reauth_required' | 'temporarily_unavailable'> {
    try {
      const refreshToken = decryptToken(row.refresh_token_encrypted!, this.environment);
      const response = await this.requestRefresh(row.source, refreshToken);
      if (response.error) {
        if (isUnrecoverableRefreshError(response.error)) {
          await this.markReauthRequired(row.github_user_id, response.error);
          return 'reauth_required';
        }
        return 'temporarily_unavailable';
      }
      if (!response.access_token) return 'temporarily_unavailable';
      const now = Date.now();
      await this.capture({
        id: row.github_user_id,
        login: row.github_username,
        username: row.github_username,
        displayName: row.github_username,
        email: null,
        avatarUrl: null,
        oauthSource: row.source,
        accessToken: response.access_token,
        refreshToken: response.refresh_token || refreshToken,
        tokenExpiresAt: response.expires_in ? now + response.expires_in * 1000 : undefined,
        refreshTokenExpiresAt: response.refresh_token_expires_in
          ? now + response.refresh_token_expires_in * 1000
          : timestamp(row.refresh_token_expires_at_ms),
      });
      return 'refreshed';
    } catch (error) {
      console.warn('GitHub user grant refresh failed:', (error as Error).message);
      return 'temporarily_unavailable';
    }
  }

  private async markReauthRequired(githubUserId: string, errorCode: string): Promise<void> {
    await this.database<GrantRow>('github_user_grants')
      .where({ github_user_id: githubUserId })
      .update({
        status: 'reauth_required',
        last_error_code: errorCode.slice(0, 64),
        updated_at: this.database.fn.now(),
      });
  }

  private async requestRefresh(source: GrantRow['source'], refreshToken: string): Promise<RefreshResponse> {
    let endpoint: string;
    let headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
    let body: Record<string, string>;
    if (source === 'connect') {
      const relayUrl = this.environment.PROPR_GH_RELAY_URL?.trim().replace(/\/+$/, '');
      const relayToken = this.environment.PROPR_GH_RELAY_TOKEN?.trim();
      if (!relayUrl || !relayToken) throw new Error('ProPR Connect credentials are unavailable for GitHub reauthorization');
      const refreshUrl = new URL(`${relayUrl}/auth/instance-grants/refresh`);
      if (refreshUrl.protocol !== 'https:' && refreshUrl.hostname !== 'localhost' && refreshUrl.hostname !== '127.0.0.1') {
        throw new Error('PROPR_GH_RELAY_URL must use HTTPS');
      }
      endpoint = refreshUrl.toString();
      headers = { ...headers, authorization: `Bearer ${relayToken}` };
      body = { refresh_token: refreshToken };
    } else {
      const clientId = this.environment.GH_OAUTH_CLIENT_ID?.trim();
      const clientSecret = this.environment.GH_OAUTH_CLIENT_SECRET?.trim();
      if (!clientId || !clientSecret) throw new Error('GitHub OAuth client credentials are unavailable for token refresh');
      endpoint = 'https://github.com/login/oauth/access_token';
      body = { client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken };
    }
    const response = await this.fetchImpl(endpoint, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub user grant refresh failed with HTTP ${response.status}`);
    return response.json() as Promise<RefreshResponse>;
  }
}

export const githubUserGrantService = new GitHubUserGrantService();
