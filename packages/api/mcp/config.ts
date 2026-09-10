export const MCP_SCOPES = ['read', 'plan', 'publish', 'execute', 'review', 'merge', 'deploy', 'manage'] as const;
export type McpScope = typeof MCP_SCOPES[number];

export interface McpConfig {
  origin: string;
  resource: string;
  instanceId: string;
  encryptionKey: Buffer;
  connect?: { issuer: string; jwks: string; installationId: string; introspection: string; secret: string };
}

function httpsUrl(value: string | undefined, name: string): string {
  if (!value) throw new Error(`MCP: ${name} is required`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new Error(`MCP: ${name} must be an HTTPS URL without credentials, query or fragment`);
  }
  return url.href;
}

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig | undefined {
  if (env.MCP_ENABLED !== 'true') return undefined;
  const origin = new URL(httpsUrl(env.MCP_PUBLIC_ORIGIN, 'MCP_PUBLIC_ORIGIN')).origin;
  if (new URL(env.MCP_PUBLIC_ORIGIN!).pathname !== '/') throw new Error('MCP_PUBLIC_ORIGIN must have no path');
  if (!env.MCP_INSTANCE_ID || !/^[a-zA-Z0-9_-]{8,128}$/.test(env.MCP_INSTANCE_ID)) throw new Error('MCP_INSTANCE_ID must be a stable 8–128 character identifier');
  const encryptionKey = Buffer.from(env.MCP_ENCRYPTION_KEY || '', 'base64');
  if (encryptionKey.length !== 32) throw new Error('MCP_ENCRYPTION_KEY must contain 32 random bytes encoded as base64');
  const config: McpConfig = { origin, resource: `${origin}/api/mcp`, instanceId: env.MCP_INSTANCE_ID, encryptionKey };
  if (env.MCP_CONNECT_TRUST === 'true') {
    if (!/^\d+$/.test(env.MCP_CONNECT_INSTALLATION_ID || '') || !env.MCP_CONNECT_INTROSPECTION_SECRET) {
      throw new Error('MCP Connect trust requires MCP_CONNECT_INSTALLATION_ID and MCP_CONNECT_INTROSPECTION_SECRET');
    }
    config.connect = {
      issuer: httpsUrl(env.MCP_CONNECT_ISSUER, 'MCP_CONNECT_ISSUER').replace(/\/$/, ''),
      jwks: httpsUrl(env.MCP_CONNECT_JWKS_URL, 'MCP_CONNECT_JWKS_URL'),
      introspection: httpsUrl(env.MCP_CONNECT_INTROSPECTION_URL, 'MCP_CONNECT_INTROSPECTION_URL'),
      installationId: env.MCP_CONNECT_INSTALLATION_ID!, secret: env.MCP_CONNECT_INTROSPECTION_SECRET,
    };
  }
  return config;
}

export class McpError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}
