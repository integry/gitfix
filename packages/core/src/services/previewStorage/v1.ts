import { createHash } from 'node:crypto';
import {
  parsePreviewStorageStatusV1, parsePreviewUploadV1, parsePreviewArtifactV1, validateRoutingUrl,
  type ManagedPreviewStorageStatus, type PreviewArtifactV1, type PreviewObjectV1,
  type PreviewUploadRequestV1, type PreviewFinalizeRequestV1, type PreviewStorageErrorCodeV1,
} from '@propr/shared';

export interface PreviewStorageConnectContext {
  connected: boolean;
  connectAccount?: { installationId: number; hasPlusAccess: boolean };
}
export interface ManagedPreviewStorageClientV1Options {
  routingUrl: string;
  relayToken: string;
  getConnectContext: () => Promise<PreviewStorageConnectContext>;
  fetchImpl?: typeof fetch;
}
/** Fixed diagnostics only: raw fetch errors, response bodies, and URLs must never escape. */
export class PreviewStorageError extends Error {
  constructor(readonly code: PreviewStorageErrorCodeV1) {
    super(`Managed preview storage: ${code}`);
    this.name = 'PreviewStorageError';
  }
}
export type ManagedPreviewUploadResult =
  | { stored: true; artifact: PreviewArtifactV1 }
  | { stored: false; code: PreviewStorageErrorCodeV1 | 'plus_required' | 'disabled' };

function matches(left: PreviewObjectV1, right: PreviewObjectV1): boolean {
  return left.sizeBytes === right.sizeBytes && left.contentType === right.contentType && left.sha256 === right.sha256;
}

/** Isolated v1 transport; no billing decisions, no cached entitlement, no automatic mutation retries. */
export class ManagedPreviewStorageClientV1 {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: ManagedPreviewStorageClientV1Options) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async relay(endpoint: string, method = 'GET', body?: unknown): Promise<Response> {
    try {
      if (validateRoutingUrl(this.options.routingUrl) || !this.options.relayToken) throw new PreviewStorageError('unavailable');
      const base = new URL(this.options.routingUrl);
      if (base.username || base.password) throw new PreviewStorageError('unavailable');
      base.protocol = base.protocol === 'wss:' ? 'https:' : base.protocol === 'ws:' ? 'http:' : base.protocol;
      return await this.fetchImpl(new URL(endpoint, base), {
        method, redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${this.options.relayToken}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new PreviewStorageError('unavailable'); }
  }

  async getStatus(): Promise<ManagedPreviewStorageStatus> {
    const unavailable: ManagedPreviewStorageStatus = { version: 1, state: 'unavailable', enabled: false, effective: null };
    try {
      const context = await this.options.getConnectContext();
      if (!context.connected || !context.connectAccount) return unavailable;
      if (!context.connectAccount.hasPlusAccess) return { ...unavailable, state: 'plus_required' };
      const response = await this.relay('/v1/preview-storage/status');
      if (!response.ok) return unavailable;
      const effective = parsePreviewStorageStatusV1(await response.json());
      if (!effective || effective.installationId !== context.connectAccount.installationId) return unavailable;
      return { version: 1, enabled: effective.enabled, state: effective.enabled ? 'enabled' : 'disabled', effective };
    } catch { return unavailable; }
  }

  private async checkResponse(response: Response, fallback: PreviewStorageErrorCodeV1): Promise<void> {
    if (response.ok) return;
    if (response.status === 413) throw new PreviewStorageError('object_too_large');
    // Only known codes survive. Server messages can contain signed URLs or credentials.
    try {
      const value = await response.json() as { code?: unknown };
      if (['quota_exceeded', 'object_too_large', 'content_type_not_allowed', 'object_mismatch'].includes(value?.code as string)) {
        throw new PreviewStorageError(value.code as PreviewStorageErrorCodeV1);
      }
    } catch (error) {
      if (error instanceof PreviewStorageError) throw error;
    }
    throw new PreviewStorageError(fallback);
  }

  /** A private snapshot is hashed and PUT unchanged, even if the caller later mutates its buffer. */
  async uploadOriginal(input: { bytes: Uint8Array; contentType: string; repository: string }): Promise<ManagedPreviewUploadResult> {
    try {
      const status = await this.getStatus();
      if (status.state !== 'enabled') return { stored: false, code: status.state };
      if (!status.effective) throw new PreviewStorageError('invalid_contract');
      const limits = status.effective;
      if (input.bytes.byteLength > limits.maxObjectBytes) throw new PreviewStorageError('object_too_large');
      if (input.bytes.byteLength > limits.quotaBytes - limits.usedBytes - limits.reservedBytes) throw new PreviewStorageError('quota_exceeded');
      if (!limits.allowedContentTypes.includes(input.contentType)) throw new PreviewStorageError('content_type_not_allowed');
      if (!input.bytes.byteLength || !/^[\w.-]+\/[\w.-]+$/.test(input.repository)) throw new PreviewStorageError('object_mismatch');
      const bytes = Buffer.from(input.bytes);
      const original: PreviewUploadRequestV1 = {
        version: 1, repository: input.repository, sizeBytes: bytes.byteLength, contentType: input.contentType,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      const response = await this.relay('/v1/preview-artifacts/uploads', 'POST', original);
      await this.checkResponse(response, 'upload_failed');
      const upload = parsePreviewUploadV1(await response.json());
      if (!upload) throw new PreviewStorageError('invalid_contract');
      if (!matches(original, upload) || Date.parse(upload.put.expiresAt) <= Date.now()) throw new PreviewStorageError('object_mismatch');
      let put: Response;
      try {
        put = await this.fetchImpl(upload.put.url, {
          method: 'PUT', headers: upload.put.headers, body: bytes,
          redirect: 'error', signal: AbortSignal.timeout(120_000),
        });
      } catch { throw new PreviewStorageError('upload_failed'); }
      // Never read or propagate an object-store error body (it can echo a signed request).
      if (!put.ok) throw new PreviewStorageError(put.status === 413 ? 'object_too_large' : 'upload_failed');
      const finalize: PreviewFinalizeRequestV1 = {
        version: 1, objectKey: upload.objectKey, sizeBytes: original.sizeBytes,
        contentType: original.contentType, sha256: original.sha256,
      };
      const finalized = await this.relay(`/v1/preview-artifacts/${upload.artifactId}/finalize`, 'POST', finalize);
      await this.checkResponse(finalized, 'finalize_failed');
      const artifact = parsePreviewArtifactV1(await finalized.json());
      if (!artifact || artifact.artifactId !== upload.artifactId || artifact.objectKey !== upload.objectKey
        || !matches(original, artifact)) throw new PreviewStorageError('object_mismatch');
      return { stored: true, artifact };
    } catch (error) {
      return { stored: false, code: error instanceof PreviewStorageError ? error.code : 'invalid_contract' };
    }
  }

  async deleteArtifact(artifactId: string): Promise<void> {
    try {
      const status = await this.getStatus();
      if (!status.enabled) throw new PreviewStorageError('unavailable');
      if (!status.effective?.deleteSupported) throw new PreviewStorageError('delete_unsupported');
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(artifactId)) throw new PreviewStorageError('invalid_contract');
      await this.checkResponse(await this.relay(`/v1/preview-artifacts/${artifactId}`, 'DELETE'), 'delete_failed');
    } catch (error) {
      throw new PreviewStorageError(error instanceof PreviewStorageError ? error.code : 'delete_failed');
    }
  }
}
