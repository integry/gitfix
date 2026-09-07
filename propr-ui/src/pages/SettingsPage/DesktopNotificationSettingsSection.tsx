import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, Loader2 } from 'lucide-react';
import type {
  DesktopNotificationPreferences,
  DesktopNotificationSettings,
} from '../../../../apps/desktop/src/shared/contract';
import { useCurrentUser } from '../../contexts/AuthContext';
import { useDesktop } from '../../desktop/DesktopContext';

const EVENT_OPTIONS: Array<{
  key: keyof Omit<DesktopNotificationPreferences, 'enabled'>;
  label: string;
  description: string;
}> = [
  { key: 'taskStarted', label: 'Task started', description: 'When a queued task begins running.' },
  { key: 'taskCompleted', label: 'Task completed', description: 'When a task finishes successfully.' },
  { key: 'taskFailed', label: 'Task failed', description: 'When a task stops with an error.' },
  { key: 'taskNeedsAttention', label: 'Needs attention', description: 'When a task requires an action, where supported.' },
];

const Toggle: React.FC<{
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange(checked: boolean): void;
}> = ({ checked, disabled, label, onChange }) => (
  <label className="inline-flex items-center gap-1.5 text-xs text-gray-600">
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={event => onChange(event.target.checked)}
      className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
    />
    <span className="sr-only">{label}</span>
  </label>
);

// Capability, enrollment, loading, and unsupported states share one compact settings surface.
const DesktopNotificationSettingsSection: React.FC = () => {
  const desktop = useDesktop();
  const user = useCurrentUser();
  const userId = user?.id;
  const notifications = desktop?.notifications;
  const scope = useMemo(
    () => notifications && userId ? notifications.scopeFor(userId) : null,
    [notifications, userId],
  );
  const [settings, setSettings] = useState<DesktopNotificationSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const scopeGeneration = useRef(0);
  const currentScope = useRef(scope);
  currentScope.current = scope;

  useEffect(() => {
    const generation = ++scopeGeneration.current;
    let current = true;
    setSettings(null);
    setBusy(false);
    setError(null);
    setTestResult(null);
    if (!notifications || !scope) return;
    void notifications.bridge.get(scope).then(value => {
      if (current && scopeGeneration.current === generation) setSettings(value);
    }).catch(loadError => {
      if (current && scopeGeneration.current === generation) {
        setError((loadError as Error).message || 'Desktop notification settings could not be loaded.');
      }
    });
    return () => { current = false; };
  }, [notifications, scope]);

  if (!notifications || !scope) return null;

  const update = async (change: Partial<DesktopNotificationPreferences>): Promise<void> => {
    const generation = scopeGeneration.current;
    const operationScope = scope;
    const operationIsCurrent = (): boolean => scopeGeneration.current === generation
      && currentScope.current === operationScope;
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const value = await notifications.bridge.update(scope, change);
      if (operationIsCurrent()) setSettings(value);
    } catch (updateError) {
      if (operationIsCurrent()) {
        setError((updateError as Error).message || 'Desktop notification settings could not be saved.');
      }
    } finally {
      if (operationIsCurrent()) setBusy(false);
    }
  };

  const test = async (): Promise<void> => {
    const generation = scopeGeneration.current;
    const operationScope = scope;
    const operationIsCurrent = (): boolean => scopeGeneration.current === generation
      && currentScope.current === operationScope;
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await notifications.bridge.test(scope);
      if (operationIsCurrent()) {
        setTestResult(result.invoked
          ? 'Test sent. Your operating system decides whether a banner is displayed.'
          : 'The native notification service is unavailable or disabled.');
      }
    } catch (testError) {
      if (operationIsCurrent()) {
        setError((testError as Error).message || 'The test notification could not be sent.');
      }
    } finally {
      if (operationIsCurrent()) setBusy(false);
    }
  };

  const capability = settings?.capability;
  const unsupported = capability?.supported === false;
  const windowsDeferred = capability?.reason === 'platform-deferred';
  const disabled = busy || !settings || unsupported;

  return (
    <section aria-labelledby="desktop-notification-settings-heading">
      <div className="mb-4 flex items-center gap-2">
        <BellRing className="h-4 w-4 text-gray-500" />
        <h4 id="desktop-notification-settings-heading" className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
          Desktop notifications
        </h4>
        {(!settings || busy) && <Loader2 aria-label="Loading desktop notification preferences" className="h-3.5 w-3.5 animate-spin text-gray-400" />}
      </div>

      <p className="mb-3 text-[11px] leading-5 text-gray-500">
        Native task alerts for {desktop.profile.name} on this device. These are separate from Browser push and inbox preferences.
      </p>

      {unsupported ? (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs leading-5 text-gray-700">
          {windowsDeferred
            ? 'Native task notifications are currently available on Linux and macOS. Windows support is planned.'
            : 'Native notifications are not available in this desktop environment.'}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-gray-200 bg-gray-50 p-3">
            <div>
              <p className="text-xs font-medium text-gray-700">Enable on this device</p>
              <p className="mt-0.5 text-[11px] text-gray-500">Off until you choose to enable it. ProPR never prompts on launch.</p>
            </div>
            <Toggle
              label="Enable desktop notifications on this device"
              checked={settings?.preferences.enabled ?? false}
              disabled={disabled}
              onChange={enabled => void update({ enabled })}
            />
          </div>

          <div className="divide-y divide-gray-100 border-y border-gray-100">
            {EVENT_OPTIONS.map(option => (
              <div key={option.key} className="flex items-center justify-between gap-4 py-2.5">
                <div>
                  <p className="text-xs font-medium text-gray-700">{option.label}</p>
                  <p className="text-[11px] text-gray-500">{option.description}</p>
                </div>
                <Toggle
                  label={`Desktop notification for ${option.label}`}
                  checked={settings?.preferences[option.key] ?? false}
                  disabled={disabled}
                  onChange={checked => void update({ [option.key]: checked })}
                />
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={disabled || !settings?.preferences.enabled}
              onClick={() => void test()}
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Send test notification
            </button>
            <span className="text-[11px] leading-5 text-gray-500">
              OS notification settings, Focus, and Do Not Disturb can suppress banners.
            </span>
          </div>
        </div>
      )}

      {testResult && <p role="status" className="mt-3 text-xs text-green-700">{testResult}</p>}
      {error && <p role="alert" className="mt-3 text-xs text-red-600">{error}</p>}
    </section>
  );
};

export default DesktopNotificationSettingsSection;
