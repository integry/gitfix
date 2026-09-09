import React, { useEffect } from 'react';
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

  return (
    <div className="desktop-instance-selector">
      <span className="desktop-instance-selector-label">Instance</span>
      <button
        type="button"
        className={`desktop-instance-selector-button desktop-connection-${connectionClass}`}
        onClick={activated ? desktop.openProfileManager : desktop.retry}
        aria-label={`${statusLabel}: ${desktop.profile.name}`}
        title={activated ? 'Manage instances' : 'Retry connection'}
      >
        <span className="desktop-instance-icon" aria-hidden="true">
          {connected ? <InstanceIcon /> : reconnecting ? <RefreshCw className="desktop-spin" /> : incompatible ? <CircleAlert /> : <CloudOff />}
        </span>
        <span className="desktop-instance-copy">
          <strong>{desktop.profile.name}</strong>
          <small>{instanceLabel}</small>
          <small className="desktop-instance-status">
            <span className="desktop-connection-dot" aria-hidden="true" />
            {statusLabel}
          </small>
        </span>
        {activated
          ? <ChevronDown className="desktop-instance-action" aria-hidden="true" />
          : <RefreshCw className="desktop-instance-action" aria-hidden="true" />}
      </button>
    </div>
  );
};
