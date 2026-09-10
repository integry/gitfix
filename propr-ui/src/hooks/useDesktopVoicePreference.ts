import { useCallback, useSyncExternalStore } from 'react';
import { getDesktopConnectionScope, subscribeDesktopConnectionScope } from '../api/apiClient';
import { isDesktopRuntime } from '../config/runtimeMode';
import { useCurrentUser } from '../contexts/AuthContext';
import { useDesktop } from '../desktop/DesktopContext';

const CHANGE_EVENT = 'propr:desktop-voice-preference';
const failedDisables = new Set<string>();

// Like other local UI preferences, this stays on the device. Never inherit a
// browser disclosure acknowledgement or another account's opt-in.
export function desktopVoicePreferenceKey(profileId: string, baseUrl: string, userId: string): string {
  return `propr.desktop.voice.experimental.v1:${JSON.stringify([profileId, baseUrl, userId])}`;
}

export function readDesktopVoicePreference(key: string | null): boolean {
  if (!key || failedDisables.has(key)) return false;
  try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}

export function subscribeDesktopVoicePreference(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

export function saveDesktopVoicePreference(key: string, enabled: boolean): void {
  // A failed write must still stop voice immediately for this session.
  if (!enabled) failedDisables.add(key);
  try {
    localStorage.setItem(key, String(enabled));
    failedDisables.delete(key);
  } finally {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }
}

export function useDesktopVoicePreference() {
  const desktop = useDesktop();
  const user = useCurrentUser();
  const connection = useSyncExternalStore(subscribeDesktopConnectionScope, getDesktopConnectionScope);
  const isDesktop = isDesktopRuntime();
  const key = isDesktop && desktop && user && connection
    && connection.profileId === desktop.profile.id
    && desktop.connection.status === 'ready'
    && connection.transportScope === desktop.connection.transportScope
    ? desktopVoicePreferenceKey(desktop.profile.id, desktop.profile.baseUrl, user.id)
    : null;
  const isEnabled = useCallback(() => !isDesktop || (
    connection === getDesktopConnectionScope() && readDesktopVoicePreference(key)
  ), [connection, isDesktop, key]);
  const enabled = useSyncExternalStore(subscribeDesktopVoicePreference, isEnabled);
  const setEnabled = (next: boolean) => {
    if (key && connection === getDesktopConnectionScope()) saveDesktopVoicePreference(key, next);
  };
  return { enabled, isEnabled, setEnabled, available: key !== null, key, connection };
}
