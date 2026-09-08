import { useEffect, useEffectEvent, useState } from 'react';
import { navigateToUiPath } from '../config/runtimeMode';
import type {
  DesktopNativeCommand,
  DesktopNativeCommandDelivery,
} from '../../../apps/desktop/src/shared/contract';
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

const commandPaths: Record<Exclude<DesktopNativeCommand, 'manage-instances' | 'quit'>, string> = {
  'new-plan': '/studio/new',
  tasks: '/tasks',
  plans: '/plans',
  inbox: '/inbox',
  'notification-settings': '/settings',
};

const confirmPlanStudioDiscard = (): boolean => {
  const current = new URL(
    window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash || '/',
    'https://desktop.propr.invalid',
  ).pathname;
  return !current.startsWith('/studio/')
    || window.confirm('Leave this plan? Any unsaved changes will be lost.');
};

const matchesConnectedScope = (
  connectionScope: DesktopNativeCommandDelivery['connectionScope'],
  state: Extract<ExperienceState, { phase: 'connected' }>,
): boolean => Boolean(connectionScope
  && state.profile.id === connectionScope.profileId
  && state.result.profileId === connectionScope.profileId
  && state.result.transportScope === connectionScope.transportScope);

export const useDesktopNativeCommands = ({
  app,
  state,
  instanceChooserBlocked,
  onManageInstances,
  onChooseInstances,
  onReconnect,
}: DesktopNativeCommandOptions): void => {
  const [pendingCommand, setPendingCommand] = useState<DesktopNativeCommandDelivery | null>(null);

  useEffect(() => app.onNativeCommand?.(setPendingCommand), [app]);

  useEffect(() => {
    if (!pendingCommand) return;
    const { command, connectionScope } = pendingCommand;
    if (command === 'quit') {
      if (confirmPlanStudioDiscard()) void app.quit?.().catch(() => undefined);
      setPendingCommand(null);
      return;
    }
    if (command === 'manage-instances') {
      if (state.phase === 'loading' || state.phase === 'connecting' || state.phase === 'authenticating') return;
      if (!confirmPlanStudioDiscard()) {
        setPendingCommand(null);
        return;
      }
      if (state.phase === 'connected') onManageInstances();
      else {
        if (instanceChooserBlocked) return;
        onChooseInstances();
      }
      setPendingCommand(null);
      return;
    }
    if (state.phase !== 'connected') return;
    if (!matchesConnectedScope(connectionScope, state)) {
      setPendingCommand(null);
      return;
    }
    const target = commandPaths[command];
    const current = new URL(
      window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash || '/',
      'https://desktop.propr.invalid',
    ).pathname;
    if (current !== target && current.startsWith('/studio/')
      && !confirmPlanStudioDiscard()) {
      setPendingCommand(null);
      return;
    }
    if (current !== target) navigateToUiPath(target);
    setPendingCommand(null);
  }, [app, instanceChooserBlocked, onChooseInstances, onManageInstances, pendingCommand, state]);

  // Effect Events expose only the latest committed render, and update before
  // layout effects can dispatch a shortcut for that commit.
  const handleKeyboard = useEffectEvent((event: KeyboardEvent) => {
    if (state.phase !== 'connected') return;
    if (!app.onNativeCommand && (event.metaKey || event.ctrlKey)
        && event.shiftKey && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      if (confirmPlanStudioDiscard()) onManageInstances();
    } else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      void onReconnect(state.profile);
    }
  });

  useEffect(() => {
    document.addEventListener('keydown', handleKeyboard);
    return () => document.removeEventListener('keydown', handleKeyboard);
    // Effect Events must not be dependencies of the effect that invokes them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
};
