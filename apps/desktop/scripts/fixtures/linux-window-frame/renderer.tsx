import React from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopExperience } from '../../../../../propr-ui/src/desktop/DesktopExperience';
import { DesktopInstanceSelector } from '../../../../../propr-ui/src/desktop/DesktopInstanceSelector';
import type { DesktopAdapters } from '../../../../../propr-ui/src/desktop/types';
import type { DesktopWindowControlActions } from '../../../../../propr-ui/src/desktop/DesktopWindowControls';

const profile = { id: 'local', name: 'This computer', kind: 'local' as const, baseUrl: 'http://127.0.0.1:3000' };
const adapters: DesktopAdapters = {
  platform: 'linux',
  app: {
    ...(window as unknown as { frameFixture: DesktopWindowControlActions }).frameFixture,
    onDeepLink: () => () => undefined,
  },
  profiles: {
    list: async () => [profile], getActiveId: async () => null,
    save: async () => undefined, remove: async () => undefined, setActiveId: async () => undefined,
  },
  connection: { probe: async () => ({ status: 'ready' }) },
  discovery: { supported: false, discover: async () => [] },
  localSetup: { supported: true },
  authentication: { authenticate: async () => undefined },
  externalBrowser: { open: async () => undefined },
};

createRoot(document.getElementById('root')!).render(
  <DesktopExperience adapters={adapters}><DesktopInstanceSelector /></DesktopExperience>,
);
