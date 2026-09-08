import { useEffect, useState } from 'react';
import { navigateToUiPath } from '../config/runtimeMode';
import type { DesktopNativeCommand } from '../../../apps/desktop/src/shared/contract';
import type { ExperienceState } from './desktopExperienceState';
import type { DesktopAdapters, DesktopProfile } from './types';

interface DesktopNativeCommandOptions {
  app: DesktopAdapters['app'];
  state: ExperienceState;
  instanceChooserBlocked: boolean;
  onManageInstances(): void;
  onChooseInstances(): void;
  onReconnect(profile: DesktopProfile): Promise<void>;
}

const commandPaths: Record<Exclude<DesktopNativeCommand, 'manage-instances'>, string> = {
  'new-plan': '/studio/new',
  tasks: '/tasks',
  plans: '/plans',
  inbox: '/inbox',
  'notification-settings': '/settings',
};

export const useDesktopNativeCommands = ({
  app,
  state,
  instanceChooserBlocked,
  onManageInstances,
  onChooseInstances,
  onReconnect,
}: DesktopNativeCommandOptions): void => {
  const [pendingCommand, setPendingCommand] = useState<DesktopNativeCommand | null>(null);

  useEffect(() => app.onNativeCommand?.(setPendingCommand), [app]);

  useEffect(() => {
    if (!pendingCommand) return;
    if (pendingCommand === 'manage-instances') {
      if (state.phase === 'loading' || state.phase === 'connecting' || state.phase === 'authenticating') return;
      if (state.phase === 'connected') onManageInstances();
      else {
        if (instanceChooserBlocked) return;
        onChooseInstances();
      }
      setPendingCommand(null);
      return;
    }
    if (state.phase !== 'connected') return;
    const target = commandPaths[pendingCommand];
    const current = new URL(
      window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash || '/',
      'https://desktop.propr.invalid',
    ).pathname;
    if (current !== target && current.startsWith('/studio/')
      && !window.confirm('Leave this plan? Any unsaved changes will be lost.')) {
      setPendingCommand(null);
      return;
    }
    if (current !== target) navigateToUiPath(target);
    setPendingCommand(null);
  }, [instanceChooserBlocked, onChooseInstances, onManageInstances, pendingCommand, state.phase]);

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if (state.phase !== 'connected') return;
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        onManageInstances();
      } else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        void onReconnect(state.profile);
      }
    };
    document.addEventListener('keydown', handleKeyboard);
    return () => document.removeEventListener('keydown', handleKeyboard);
  }, [onManageInstances, onReconnect, state]);
};
