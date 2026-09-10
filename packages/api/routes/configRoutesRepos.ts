import type * as configManager from '@propr/core';
import { withDefaultRepoOptions } from './configRepoValidation.js';

type RepoConfigStore = Pick<typeof configManager, 'loadMonitoredReposRaw' | 'loadGitHubAttachmentCapacity'>;

export async function loadReposWithAttachmentCapacity(configStore: RepoConfigStore) {
  const repos = (await configStore.loadMonitoredReposRaw()).map(withDefaultRepoOptions);
  const detected = repos.some(repo => !repo.visualPreview?.githubAttachmentPlan || repo.visualPreview.githubAttachmentPlan === 'auto')
    ? await configStore.loadGitHubAttachmentCapacity() : undefined;
  return Promise.all(repos.map(async repo => ({
    ...repo,
    visualPreview: {
      ...repo.visualPreview!,
      githubAttachmentPlan: repo.visualPreview?.githubAttachmentPlan ?? 'auto',
      githubAttachmentCapacity: !repo.visualPreview?.githubAttachmentPlan || repo.visualPreview.githubAttachmentPlan === 'auto'
        ? detected : await configStore.loadGitHubAttachmentCapacity(repo.visualPreview.githubAttachmentPlan),
    },
  })));
}
