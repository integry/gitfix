import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { db } from '@propr/core';
import { CONFIG_EVENT_CHANNEL } from '../services/configReloadSubscription.js';
import { MCP_SCOPES } from '../mcp/config.js';
import {
  loadMcpAdminSettings,
  saveMcpAdminSettingRows,
  resolveMcpStatus,
  invalidateMcpConfigCache,
} from '../mcp/configResolver.js';

interface AdminMcpRoutesDeps {
  database?: Knex;
  redisClient?: { publish(channel: string, message: string): Promise<unknown> };
}

async function logActivity(
  redisClient: AdminMcpRoutesDeps['redisClient'],
  description: string,
  username?: string,
): Promise<void> {
  if (!redisClient) return;
  try {
    const activity = {
      id: `activity-${Date.now()}-mcp`,
      type: 'mcp_settings_updated',
      timestamp: new Date().toISOString(),
      user: username,
      description,
      status: 'success',
    };
    await redisClient.publish('system:activity:log', JSON.stringify(activity));
  } catch { /* non-critical */ }
}

async function publishMcpUpdate(redisClient: AdminMcpRoutesDeps['redisClient']): Promise<void> {
  if (!redisClient) return;
  try {
    await redisClient.publish(CONFIG_EVENT_CHANNEL, JSON.stringify({ type: 'config_update', subtype: 'mcp_settings_update', timestamp: Date.now() }));
  } catch { /* non-critical */ }
}

export function createAdminMcpRoutes({ database = db, redisClient }: AdminMcpRoutesDeps = {}) {
  async function getSettings(req: Request, res: Response): Promise<void> {
    try {
      const status = await resolveMcpStatus(database);
      const adminSettings = await loadMcpAdminSettings(database);
      res.json({
        status,
        settings: {
          enabled: adminSettings.enabled,
          scopeCeiling: adminSettings.scopeCeiling,
          connectEnabled: adminSettings.connectEnabled,
        },
        scopes: [...MCP_SCOPES],
      });
    } catch (error) {
      console.error('Failed to get MCP admin settings:', error);
      res.status(500).json({ error: 'Failed to get MCP settings' });
    }
  }

  async function putSettings(req: Request, res: Response): Promise<void> {
    const { enabled, scopeCeiling, connectEnabled } = req.body ?? {};

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean', code: 'INVALID_INPUT' }); return;
    }
    if (scopeCeiling !== undefined) {
      if (!Array.isArray(scopeCeiling) || scopeCeiling.some((s: unknown) => typeof s !== 'string' || !(MCP_SCOPES as readonly string[]).includes(s))) {
        res.status(400).json({ error: 'scopeCeiling must be an array of valid MCP scopes', code: 'INVALID_INPUT' }); return;
      }
    }
    if (connectEnabled !== undefined && typeof connectEnabled !== 'boolean') {
      res.status(400).json({ error: 'connectEnabled must be a boolean', code: 'INVALID_INPUT' }); return;
    }

    try {
      // Check operator override before allowing enable
      if (enabled === true && process.env.MCP_ENABLED === 'false') {
        res.status(403).json({ error: 'MCP is disabled by operator configuration', code: 'OPERATOR_DISABLED' }); return;
      }
      if (enabled === true && process.env.NODE_ENV !== 'test') {
        const status = await resolveMcpStatus(database);
        if (status.demoMode) {
          res.status(403).json({ error: 'MCP cannot be enabled in demo mode', code: 'DEMO_MODE' }); return;
        }
        if (status.missingHttpsOrigin) {
          res.status(400).json({ error: 'MCP requires an HTTPS origin (API_PUBLIC_URL or GH_OAUTH_CALLBACK_URL)', code: 'MISSING_HTTPS_ORIGIN' }); return;
        }
        if (status.missingSecretChain) {
          res.status(400).json({ error: 'MCP requires an encryption secret (PROPR_CREDENTIAL_ENCRYPTION_KEY, SYSTEM_TASK_SECRET, or SESSION_SECRET)', code: 'MISSING_SECRET_CHAIN' }); return;
        }
      }

      const updates: Record<string, string> = {};
      if (enabled !== undefined) updates.enabled = String(enabled);
      if (scopeCeiling !== undefined) updates.scope_ceiling = JSON.stringify(scopeCeiling);
      if (connectEnabled !== undefined) updates.connect_enabled = String(connectEnabled);

      if (Object.keys(updates).length > 0) {
        await saveMcpAdminSettingRows(updates, database);
        invalidateMcpConfigCache();
        await publishMcpUpdate(redisClient);
        await logActivity(redisClient, `MCP server ${enabled !== undefined ? (enabled ? 'enabled' : 'disabled') : 'updated'}`, req.user?.username);
      }

      const newStatus = await resolveMcpStatus(database);
      res.json({ status: newStatus });
    } catch (error) {
      console.error('Failed to update MCP admin settings:', error);
      res.status(500).json({ error: 'Failed to update MCP settings' });
    }
  }

  async function revokeAll(req: Request, res: Response): Promise<void> {
    try {
      const now = Date.now();
      // Mark all grants as revoked by setting expires_at to the past
      const revoked = await database('mcp_records')
        .where({ kind: 'grant' })
        .whereRaw('(value NOT LIKE ? OR expires_at > ?)', ['%"revoked":true%', now])
        .update({ expires_at: now - 1 });

      await logActivity(redisClient, `Revoked all MCP grants (${revoked} affected)`, req.user?.username);
      res.json({ revoked });
    } catch (error) {
      console.error('Failed to revoke MCP grants:', error);
      res.status(500).json({ error: 'Failed to revoke MCP grants' });
    }
  }

  return { getSettings, putSettings, revokeAll };
}
