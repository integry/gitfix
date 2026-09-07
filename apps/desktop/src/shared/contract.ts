export const DESKTOP_PROTOCOL = 'propr';

export const IPC_CHANNELS = Object.freeze({
  appMetadata: 'desktop:app-metadata',
  authLogout: 'desktop:auth-logout',
  openExternal: 'desktop:open-external',
  storageSecurity: 'desktop:storage-security',
  profilesList: 'desktop:profiles-list',
  profilesSave: 'desktop:profiles-save',
  profilesRemove: 'desktop:profiles-remove',
  profilesSetActive: 'desktop:profiles-set-active',
  authenticationPairAdmit: 'desktop:authentication-pair-admit',
  authenticationPair: 'desktop:authentication-pair',
  authenticationCancel: 'desktop:authentication-cancel',
  authenticationProgress: 'desktop:authentication-progress',
  connectionProbe: 'desktop:connection-probe',
  connectionActivate: 'desktop:connection-activate',
  connectionDiscard: 'desktop:connection-discard',
  connectionInvalidate: 'desktop:connection-invalidate',
  connectDiscover: 'desktop:connect-discover',
  connectRediscover: 'desktop:connect-rediscover',
  lifecycleStatus: 'desktop:lifecycle-status',
  lifecycleStart: 'desktop:lifecycle-start',
  lifecycleStop: 'desktop:lifecycle-stop',
  lifecycleRestart: 'desktop:lifecycle-restart',
  setupStatus: 'desktop:setup-status',
  setupStart: 'desktop:setup-start',
  setupRetry: 'desktop:setup-retry',
  setupCancel: 'desktop:setup-cancel',
  setupSelectPrivateKey: 'desktop:setup-select-private-key',
  setupAcquireWebhookSecret: 'desktop:setup-acquire-webhook-secret',
  setupGithubInstallationDecision: 'desktop:setup-github-installation-decision',
  setupProgress: 'desktop:setup-progress',
  deepLink: 'desktop:deep-link',
  deepLinkConsumerReady: 'desktop:deep-link-consumer-ready',
  deepLinkAcknowledgement: 'desktop:deep-link-acknowledgement',
  acceptanceJourneyStage: 'desktop:acceptance-journey-stage',
} as const);

export interface DesktopDeepLinkDelivery {
  deliveryId: number;
  url: string;
}

export type DesktopDeepLinkConsumption = {
  kind: 'connect-confirmation' | 'open-queued' | 'open-navigated';
  target: string;
};

export interface DesktopDeepLinkAcknowledgement extends DesktopDeepLinkDelivery {
  consumption: DesktopDeepLinkConsumption;
}

export type DesktopAcceptanceJourneyStage =
  | 'AUTHENTICATION_REQUIRED'
  | 'CREDENTIAL_COMMITTED'
  | 'AUTHENTICATED_REPROBE_READY'
  | 'ACTIVATION_COMMITTED'
  | 'ACTIVATION_PUBLISHED'
  | 'REACT_CONNECTED';

export type DesktopPlatform = 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku'
  | 'linux' | 'openbsd' | 'sunos' | 'win32' | 'cygwin' | 'netbsd';

export interface DesktopAppMetadata {
  name: string;
  version: string;
  platform: DesktopPlatform;
  arch: string;
  packaged: boolean;
}

export interface DesktopProfile {
  id: string;
  label: string;
  apiBaseUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopProfileInput {
  id?: string;
  label: string;
  apiBaseUrl: string;
}

export type DesktopPairingFailureCode =
  | 'APPROVAL_EXPIRED'
  | 'SECURE_STORAGE_FAILED'
  | 'PAIRING_REJECTED'
  | 'PAIRING_UNREACHABLE'
  | 'PAIRING_CANCELLED';

export type DesktopPairingResult =
  | { paired: true }
  | { paired: false; code: DesktopPairingFailureCode };

export const isDesktopPairingOperationId = (value: unknown): value is string =>
  typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export interface DesktopPairingProgress {
  operationId: string;
  profileId: string;
  stage: 'browser-opening' | 'approval-pending' | 'browser-open-failed';
}

/** Secret-free candidate projected by the trusted main-process discovery service. */
export interface DesktopDiscoveryCandidate {
  id: string;
  label: string;
  apiBaseUrl: string;
}

export interface DesktopProfileList {
  profiles: DesktopProfile[];
  activeProfileId: string | null;
}

export type StorageSecurity = {
  available: true;
  backend: string;
} | {
  available: false;
  backend: string;
  reason: 'os-encryption-unavailable' | 'insecure-basic-text-backend';
};

export type DesktopConnectionResult =
  | { status: 'ready'; version?: string; authentication?: string; activationTicket: string }
  | { status: 'authentication-required'; message?: string; version?: string; authentication?: string }
  | { status: 'incompatible'; message: string; version?: string }
  | { status: 'offline'; message: string };

export interface DesktopConnectionScope {
  profileId: string;
  transportScope: string;
}

export interface DesktopActivatedConnection extends DesktopConnectionScope {
  status: 'ready';
  identityEpoch: string;
}

export interface DesktopAccessInvalidation extends DesktopConnectionScope {
  code: string;
}

export type LocalLifecycleState = 'disconnected' | 'starting' | 'connected' | 'stopping' | 'error';

export interface LocalLifecycleStatus {
  state: LocalLifecycleState;
  detail?: string;
}

export type LocalLifecycleOperationResult =
  | { ok: true; status: LocalLifecycleStatus }
  | { ok: false; code: 'not-implemented'; status: LocalLifecycleStatus };

export interface DesktopSetupRequest {
  sessionId: string;
  root: { mode: 'default' | 'resume' };
  reinitialize: boolean;
  agents: string[];
  github:
    | { mode: 'keep' }
    | { mode: 'relay' }
    | { mode: 'app'; appId: string; privateKeyCapability: string; installationId: string };
  intake:
    | { mode: 'keep' }
    | { mode: 'routing_websocket' }
    | { mode: 'polling' }
    | { mode: 'direct_webhook'; secretCapability: string };
  whitelist: string[] | null;
  repository: { fullName: string; alias?: string; baseBranch?: string } | null;
}

export interface DesktopSetupRecoveryRequest {
  sessionId: string;
  recoveryAction: 'replace-running-stack';
}

export interface DesktopFilesystemSelection { capability: string; label: string }
export interface DesktopSecretSelection { capability: string; label: 'Secret entered' }

export interface DesktopGithubInstallation {
  installationId: string;
  accountLogin: string;
  accountType: string;
}

export interface DesktopGithubSelectedIdentity {
  username: string;
  installation: DesktopGithubInstallation;
}

export type DesktopGithubInstallationDecision =
  | { action: 'select'; installationId: string }
  | { action: 'refresh' }
  | { action: 'install' }
  | { action: 'reauthenticate' };

export interface DesktopGithubIdentityState {
  status: 'selection-required' | 'authorization-failed' | 'refreshing' | 'installing' | 'reauthenticating' | 'enrolling' | 'enrolled';
  username: string;
  installations: DesktopGithubInstallation[];
  selectedInstallationId?: string;
  permissionExplanation?: string;
  installAvailable: boolean;
}

export interface DesktopSetupResumeView {
  agents: string[];
  reinitialize: boolean;
  github: { mode: 'keep' | 'demo' }
    | { mode: 'relay'; identity?: DesktopGithubSelectedIdentity }
    | { mode: 'app'; appId: string; installationId: string; reconfigurationRequired: true };
  intake: { mode: 'keep' | 'routing_websocket' | 'polling' }
    | { mode: 'direct_webhook'; reconfigurationRequired: true };
  whitelist: string[] | null;
  repository: { fullName: string; alias?: string; baseBranch?: string } | null;
  reconfigurationStage?: 'github' | 'intake';
}

export type DesktopSetupPhase = 'idle' | 'running' | 'interrupted' | 'cancelled' | 'failed' | 'completed' | 'unsupported';

export interface DesktopSetupProfile {
  id: string;
  name: string;
  baseUrl: string;
  kind: 'local';
}

export interface DesktopSetupSnapshot {
  phase: DesktopSetupPhase;
  capability: import('@propr/local-setup').LocalSetupCapability;
  sessionId: string;
  rootDir?: string;
  state?: import('@propr/local-setup').SetupState;
  logs: string[];
  errors?: import('@propr/local-setup').SetupStructuredError[];
  error?: string;
  profile?: DesktopSetupProfile;
  resume?: DesktopSetupResumeView;
  resumeAvailable?: boolean;
  reconfigurationRequired?: boolean;
  /** Safe identity metadata only; GitHub and relay tokens never cross IPC. */
  githubIdentity?: DesktopGithubIdentityState;
}

export interface DesktopBridge {
  app: {
    getMetadata(): Promise<DesktopAppMetadata>;
    onDeepLink(listener: (
      url: string,
    ) => DesktopDeepLinkConsumption | null | Promise<DesktopDeepLinkConsumption | null>): () => void;
  };
  auth: {
    logout(apiBaseUrl: string): Promise<void>;
  };
  external: {
    open(url: string): Promise<void>;
  };
  storage: {
    security(): Promise<StorageSecurity>;
  };
  profiles: {
    list(): Promise<DesktopProfileList>;
    save(profile: DesktopProfileInput): Promise<DesktopProfile>;
    remove(profileId: string): Promise<void>;
    setActive(profileId: string | null): Promise<void>;
  };
  authentication: {
    admit(profileId: string): Promise<{ operationId: string }>;
    pair(profile: DesktopProfileInput, operationId: string): Promise<DesktopPairingResult>;
    cancel(profileId: string): Promise<void>;
    onProgress?(listener: (progress: DesktopPairingProgress) => void): () => void;
  };
  connection: {
    probe(profile: DesktopProfileInput): Promise<DesktopConnectionResult>;
    activate(activationTicket: string): Promise<DesktopActivatedConnection>;
    discard(value: DesktopConnectionScope): Promise<{ discarded: boolean }>;
    invalidate(value: DesktopAccessInvalidation): Promise<{ invalidated: boolean }>;
  };
  discovery: {
    supported: boolean;
    discover(): Promise<DesktopDiscoveryCandidate[]>;
    rediscover(profileId: string): Promise<DesktopDiscoveryCandidate | null>;
  };
  lifecycle: {
    status(): Promise<LocalLifecycleStatus>;
    start(): Promise<LocalLifecycleOperationResult>;
    stop(): Promise<LocalLifecycleOperationResult>;
    restart(): Promise<LocalLifecycleOperationResult>;
  };
  localSetup: {
    status(): Promise<DesktopSetupSnapshot>;
    start(request: DesktopSetupRequest): Promise<DesktopSetupSnapshot>;
    retry(request?: DesktopSetupRequest | DesktopSetupRecoveryRequest): Promise<DesktopSetupSnapshot>;
    cancel(): Promise<DesktopSetupSnapshot>;
    selectPrivateKey(): Promise<DesktopFilesystemSelection | null>;
    acquireWebhookSecret(): Promise<DesktopSecretSelection | null>;
    resolveGithubInstallation(decision: DesktopGithubInstallationDecision): Promise<DesktopSetupSnapshot>;
    onProgress(listener: (snapshot: DesktopSetupSnapshot) => void): () => void;
  };
  /** @internal Present only in an authorized packaged Connect acceptance process. */
  acceptance?: {
    reportJourneyStage(stage: DesktopAcceptanceJourneyStage): Promise<void>;
  };
}
