import { resolveGitHubAttachmentCapacity } from '@propr/shared';
import type { RepoToMonitor } from '@propr/core';
import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

process.env.PROPR_DEMO_MODE = 'true';
const [{ createConfigRoutes }, { db }] = await Promise.all([
  import('../routes/configRoutes.js'),
  import('@propr/core')
]);

after(async () => {
  await db.destroy();
});

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      this.body = payload;
      return this;
    }
  };
}

test('GET repository config returns false for legacy entries with a missing option', async () => {
  const routes = createConfigRoutes({
    redisClient: {} as never,
    configStore: {
      loadMonitoredReposRaw: async () => [{ id: 'repo-1', name: 'integry/propr', enabled: true }],
      loadGitHubAttachmentCapacity: async () => resolveGitHubAttachmentCapacity()
    }
  });
  const response = createResponse();

  await routes.getRepos({} as never, response as never);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    repos_to_monitor: [{
      id: 'repo-1',
      name: 'integry/propr',
      enabled: true,
      autoFollowupOnFailedCi: false,
      visualPreview: { enabled: false, types: ['image'], githubAttachmentPlan: 'auto', githubAttachmentCapacity: resolveGitHubAttachmentCapacity() }
    }]
  });
});

test('POST repository config persists an enabled option without enabling other repositories', async () => {
  const saveMonitoredRepos = mock.fn(async () => true);
  const routes = createConfigRoutes({
    redisClient: {
      set: mock.fn(async () => 'OK'),
      eval: mock.fn(async () => 1),
      publish: mock.fn(async () => 1),
      lPush: mock.fn(async () => 1),
      lTrim: mock.fn(async () => 'OK')
    } as never,
    configStore: {
      loadMonitoredReposRaw: async () => [],
      saveMonitoredRepos,
      clearRemovedRepositoryIndexData: async () => {}
    },
    database: {
      transaction: async (callback: (transaction: never) => Promise<unknown>) => callback({} as never)
    } as never
  });
  const response = createResponse();

  await routes.postRepos({
    body: {
      repos_to_monitor: [
        { id: 'repo-1', name: 'integry/propr', enabled: true, autoFollowupOnFailedCi: true },
        { id: 'repo-2', name: 'integry/other', enabled: true }
      ]
    }
  } as never, response as never);

  assert.equal(response.statusCode, 200);
  assert.equal(saveMonitoredRepos.mock.calls.length, 1);
  assert.deepEqual(saveMonitoredRepos.mock.calls[0]?.arguments[0], [
    {
      id: 'repo-1',
      name: 'integry/propr',
      enabled: true,
      autoFollowupOnFailedCi: true,
      visualPreview: { enabled: false, types: ['image'] },
      alias: undefined,
      baseBranch: undefined,
      defaultBranch: undefined
    },
    {
      id: 'repo-2',
      name: 'integry/other',
      enabled: true,
      autoFollowupOnFailedCi: false,
      visualPreview: { enabled: false, types: ['image'] },
      alias: undefined,
      baseBranch: undefined,
      defaultBranch: undefined
    }
  ]);
});

test('POST repository config synchronizes changed visual previews across branch entries', async () => {
  const saveMonitoredRepos = mock.fn(async () => true);
  const routes = createConfigRoutes({
    redisClient: {
      set: mock.fn(async () => 'OK'),
      eval: mock.fn(async () => 1),
      publish: mock.fn(async () => 1),
      lPush: mock.fn(async () => 1),
      lTrim: mock.fn(async () => 'OK')
    } as never,
    configStore: {
      loadMonitoredReposRaw: async () => [
        {
          id: 'repo-main',
          name: 'integry/propr',
          enabled: true,
          baseBranch: 'main',
          visualPreview: { enabled: false, types: ['image'] }
        },
        {
          id: 'repo-release',
          name: 'integry/propr',
          enabled: true,
          baseBranch: 'release',
          visualPreview: { enabled: false, types: ['image'] }
        }
      ],
      saveMonitoredRepos,
      clearRemovedRepositoryIndexData: async () => {}
    },
    database: {
      transaction: async (callback: (transaction: never) => Promise<unknown>) => callback({} as never)
    } as never
  });
  const response = createResponse();
  const visualPreview = {
    githubAttachmentPlan: 'paid' as const,
    enabled: true,
    types: ['image', 'video'],
    instructions: 'Show desktop and mobile.'
  };

  await routes.postRepos({
    body: {
      repos_to_monitor: [
        { id: 'repo-main', name: 'integry/propr', enabled: true, baseBranch: 'main', visualPreview },
        {
          id: 'repo-release',
          name: 'integry/propr',
          enabled: true,
          baseBranch: 'release',
          visualPreview: { enabled: false, types: ['image'] }
        }
      ]
    }
  } as never, response as never);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    saveMonitoredRepos.mock.calls[0]?.arguments[0].map(repo => repo.visualPreview),
    [visualPreview, visualPreview]
  );
});

for (const githubAttachmentPlan of ['paid', 'free'] as const) {
  test(`GET/POST legacy branch entries preserves a ${githubAttachmentPlan} override on the first entry`, async () => {
    const saveMonitoredRepos = mock.fn<(repos: RepoToMonitor[]) => Promise<boolean>>(async () => true);
    const routes = createConfigRoutes({
      redisClient: {
        set: mock.fn(async () => 'OK'),
        eval: mock.fn(async () => 1),
        publish: mock.fn(async () => 1),
        lPush: mock.fn(async () => 1),
        lTrim: mock.fn(async () => 'OK')
      } as never,
      configStore: {
        loadMonitoredReposRaw: async () => ['main', 'release'].map(baseBranch => ({
          id: `repo-${baseBranch}`,
          name: 'integry/propr',
          enabled: true,
          baseBranch,
          visualPreview: { enabled: true, types: ['image'] }
        })),
        loadGitHubAttachmentCapacity: async () => resolveGitHubAttachmentCapacity(),
        saveMonitoredRepos,
        clearRemovedRepositoryIndexData: async () => {}
      },
      database: {
        transaction: async (callback: (transaction: never) => Promise<unknown>) => callback({} as never)
      } as never
    });
    const getResponse = createResponse();
    await routes.getRepos({} as never, getResponse as never);
    const repos = getResponse.body?.repos_to_monitor as RepoToMonitor[];
    assert.deepEqual(repos.map(repo => repo.visualPreview?.githubAttachmentPlan), ['auto', 'auto']);
    repos[0].visualPreview!.githubAttachmentPlan = githubAttachmentPlan;

    const postResponse = createResponse();
    await routes.postRepos({ body: { repos_to_monitor: repos } } as never, postResponse as never);

    assert.equal(postResponse.statusCode, 200);
    assert.equal(saveMonitoredRepos.mock.calls.length, 1);
    assert.deepEqual(
      saveMonitoredRepos.mock.calls[0].arguments[0].map(repo => repo.visualPreview),
      [
        { enabled: true, types: ['image'], githubAttachmentPlan },
        { enabled: true, types: ['image'], githubAttachmentPlan }
      ]
    );
  });
}

test('POST repository config preserves an omitted option for existing repositories', async () => {
  const saveMonitoredRepos = mock.fn(async () => true);
  const routes = createConfigRoutes({
    redisClient: {
      set: mock.fn(async () => 'OK'),
      eval: mock.fn(async () => 1),
      publish: mock.fn(async () => 1),
      lPush: mock.fn(async () => 1),
      lTrim: mock.fn(async () => 'OK')
    } as never,
    configStore: {
      loadMonitoredReposRaw: async () => [
        { id: 'repo-1', name: 'integry/propr', enabled: false, autoFollowupOnFailedCi: true },
        { id: 'repo-2', name: 'integry/other', enabled: true, autoFollowupOnFailedCi: true }
      ],
      saveMonitoredRepos,
      clearRemovedRepositoryIndexData: async () => {}
    },
    database: {
      transaction: async (callback: (transaction: never) => Promise<unknown>) => callback({} as never)
    } as never
  });
  const response = createResponse();

  await routes.postRepos({
    body: {
      repos_to_monitor: [
        { id: 'repo-1', name: 'integry/propr', enabled: true },
        { id: 'repo-2', name: 'integry/other', enabled: true, autoFollowupOnFailedCi: false },
        { id: 'repo-3', name: 'integry/new', enabled: true }
      ]
    }
  } as never, response as never);

  assert.equal(response.statusCode, 200);
  assert.equal(saveMonitoredRepos.mock.calls.length, 1);
  assert.deepEqual(
    saveMonitoredRepos.mock.calls[0]?.arguments[0].map(repo => ({
      id: repo.id,
      autoFollowupOnFailedCi: repo.autoFollowupOnFailedCi
    })),
    [
      { id: 'repo-1', autoFollowupOnFailedCi: true },
      { id: 'repo-2', autoFollowupOnFailedCi: false },
      { id: 'repo-3', autoFollowupOnFailedCi: false }
    ]
  );
});

test('GET settings exposes configured override and effective detection for every repository', async () => {
  for (const detectedPlan of ['unknown', 'free', 'paid'] as const) {
    const calls: Array<string | undefined> = [];
    const routes = createConfigRoutes({
      redisClient: {} as never,
      configStore: {
        loadMonitoredReposRaw: async () => ['auto', 'free', 'paid'].map(plan => ({ id: plan, name: `integry/${plan}`, enabled: true, visualPreview: { enabled: true, types: ['video'], githubAttachmentPlan: plan as 'auto' | 'free' | 'paid' } })),
        loadGitHubAttachmentCapacity: async override => {
          calls.push(override);
          return resolveGitHubAttachmentCapacity(override, override ? 'unknown' : detectedPlan);
        },
      },
    });
    const response = createResponse();
    await routes.getRepos({} as never, response as never);
    const repos = response.body?.repos_to_monitor as Array<{ visualPreview: { githubAttachmentPlan: string; githubAttachmentCapacity: ReturnType<typeof resolveGitHubAttachmentCapacity> } }>;
    assert.deepEqual(repos.map(repo => repo.visualPreview.githubAttachmentPlan), ['auto', 'free', 'paid']);
    for (const repo of repos) {
      const plan = repo.visualPreview.githubAttachmentPlan;
      assert.deepEqual(repo.visualPreview.githubAttachmentCapacity, resolveGitHubAttachmentCapacity(plan, plan === 'auto' ? detectedPlan : 'unknown'));
    }
    assert.deepEqual(calls, [undefined, 'free', 'paid']);
  }
});
