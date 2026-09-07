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

export const DesktopInstanceSelector: React.FC<DesktopInstanceSelectorProps> = ({ transportReady = false }) => {
  const desktop = useDesktop();
  const connected = desktop?.connection.status === 'ready';

  useEffect(() => {
    if (!connected || !transportReady) return;
    void desktop?.reportConnectedRendererReady?.().catch(() => {
      // Acceptance diagnostics must never alter the renderer lifecycle they observe.
    });
  }, [connected, desktop, transportReady]);

  if (!desktop) return null;

  const incompatible = desktop.connection.status === 'incompatible';
  const statusLabel = connected ? 'Connected' : incompatible ? 'Update required' : 'Offline';
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
        className={`desktop-instance-selector-button desktop-connection-${desktop.connection.status}`}
        onClick={connected ? desktop.openProfileManager : desktop.retry}
        aria-label={`${statusLabel}: ${desktop.profile.name}`}
        title={connected ? 'Manage instances' : 'Retry connection'}
      >
        <span className="desktop-instance-icon" aria-hidden="true">
          {connected ? <InstanceIcon /> : incompatible ? <CircleAlert /> : <CloudOff />}
        </span>
        <span className="desktop-instance-copy">
          <strong>{desktop.profile.name}</strong>
          <small>{instanceLabel}</small>
          <small className="desktop-instance-status">
            <span className="desktop-connection-dot" aria-hidden="true" />
            {statusLabel}
          </small>
        </span>
        {connected
          ? <ChevronDown className="desktop-instance-action" aria-hidden="true" />
          : <RefreshCw className="desktop-instance-action" aria-hidden="true" />}
      </button>
    </div>
  );
};
