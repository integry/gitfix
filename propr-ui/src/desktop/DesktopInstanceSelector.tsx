import { GitHubAccountIdentity } from '../components/GitHubAccountIdentity';
import React, { useEffect, useId } from 'react';
import { parseProprConnectEndpoint } from '@propr/shared';
import {
  ChevronDown,
  CircleAlert,
  Cloud,
  CloudOff,
  Computer,
  RefreshCw,
} from 'lucide-react';
import { useDesktop } from './DesktopContext';

interface DesktopInstanceSelectorProps {
  /** Authenticated REST and Socket.IO are ready for the published desktop scope. */
  transportReady?: boolean;
}

export const DesktopInstanceSelector: React.FC<DesktopInstanceSelectorProps> = ({ transportReady }) => {
  const desktop = useDesktop();
  const descriptionId = useId();
  const activated = desktop?.connection.status === 'ready';
  // The startup probe establishes the active profile and credentials. Once the
  // connected app is mounted, its scoped socket is the live reachability signal.
  const connected = Boolean(activated && transportReady !== false);
  const reconnecting = Boolean(activated && transportReady === false);

  useEffect(() => {
    if (!connected || !transportReady) return;
    void desktop?.reportConnectedRendererReady?.().catch(() => {
      // Acceptance diagnostics must never alter the renderer lifecycle they observe.
    });
  }, [connected, desktop, transportReady]);

  if (!desktop) return null;

  const incompatible = desktop.connection.status === 'incompatible';
  const statusLabel = connected ? 'Connected' : reconnecting ? 'Reconnecting' : incompatible ? 'Update required' : 'Offline';
  const connectionClass = reconnecting ? 'reconnecting' : desktop.connection.status;
  const instanceLabel = parseProprConnectEndpoint(desktop.profile.baseUrl)
    ? 'ProPR Connect'
    : desktop.profile.kind === 'local'
      ? 'Local instance'
      : 'Remote instance';
  const InstanceIcon = desktop.profile.kind === 'local' ? Computer : Cloud;
  const action = activated
    ? { onClick: desktop.openProfileManager, title: 'Manage instances', popup: 'dialog' as const, label: 'Switch', description: 'Switch instance or GitHub account.', Icon: ChevronDown }
    : { onClick: desktop.retry, title: 'Retry connection', popup: undefined, label: 'Retry', description: 'Retry connection.', Icon: RefreshCw };

  return (
    <div className="desktop-instance-selector">
      <span className="desktop-instance-selector-label">Instance</span>
      <button
        type="button"
        className={`desktop-instance-selector-button desktop-connection-${connectionClass}`}
        onClick={action.onClick}
        aria-label={`${statusLabel}: ${desktop.profile.name}`}
        aria-describedby={descriptionId}
        aria-haspopup={action.popup}
        title={action.title}
      >
        <span className="desktop-instance-icon" aria-hidden="true">
          {connected ? <InstanceIcon /> : reconnecting ? <RefreshCw className="desktop-spin" /> : incompatible ? <CircleAlert /> : <CloudOff />}
        </span>
        <span className="desktop-instance-copy">
          <strong title={desktop.profile.name}>{desktop.profile.name}</strong>
          <small>{instanceLabel}</small>
        </span>
        <span className="desktop-instance-details">
          {desktop.profile.account && (
            <span className="desktop-instance-account">
              <span className="desktop-instance-account-label">GitHub account</span>
              <span className="desktop-instance-account-identity" title={`@${desktop.profile.account.username}`}>
                <GitHubAccountIdentity account={desktop.profile.account} />
              </span>
            </span>
          )}
          <span className="desktop-instance-footer">
            <span className="desktop-instance-status">
              <span className="desktop-connection-dot" aria-hidden="true" />
              {statusLabel}
            </span>
            <span className="desktop-instance-switch">
              {action.label}
              <action.Icon className="desktop-instance-action" aria-hidden="true" />
            </span>
          </span>
        </span>
      </button>
      <span id={descriptionId} className="sr-only">
        {`${instanceLabel}. ${desktop.profile.account ? `GitHub account: @${desktop.profile.account.username}. ` : ''}${action.description}`}
      </span>
    </div>
  );
};
