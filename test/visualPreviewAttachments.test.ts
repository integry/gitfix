import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { PreviewArtifactV1 } from '@propr/shared';
import { storeManagedVisualPreviewOriginals } from '../src/github/managedVisualPreviewStorage.js';

process.env.PROPR_DEMO_MODE = 'true';

const [{ db }, {
  publishPullRequestCommentVisualPreviews,
  publishPullRequestVisualPreviews,
  resolveVisualPreviewUploadToken,
  isVisualPreviewUploadAuthenticationError,
  uploadVisualPreviewAsset,
}] = await Promise.all([
  import('@propr/core'),
  import('../src/github/visualPreviewAttachments.js')
]);

after(async () => {
  await db.destroy();
});

const evidence = {
  assets: [{
    relativePath: '.propr/previews/desktop.png',
    absolutePath: '/worktree/.propr/previews/desktop.png',
    type: 'image' as const,
    title: 'Desktop settings'
  }],
  toolSuggestions: []
};

test('resolves the dedicated visual preview upload credential', async () => {
  assert.equal(await resolveVisualPreviewUploadToken({
    GITHUB_VISUAL_PREVIEW_TOKEN: '  gho_preview-token  '
  }), 'gho_preview-token');
});

test('explains why the GitHub App credential cannot be used for attachments', async () => {
  let caught: unknown;
  try {
    await resolveVisualPreviewUploadToken({});
  } catch (error) {
    caught = error;
  }
  assert.match((caught as Error).message, /GitHub App installation tokens cannot upload attachments/);
  assert.equal(isVisualPreviewUploadAuthenticationError(caught), true);
});

test('edits a pull request with uploaded visual preview attachments', async () => {
  let invocation: { args: string[]; authToken: string; cwd: string } | undefined;
  const requests: Array<{ endpoint: string; options: Record<string, unknown> }> = [];

  await publishPullRequestVisualPreviews({
    owner: 'integry',
    repo: 'propr',
    pullRequestNumber: 42,
    body: 'Implementation summary',
    evidence,
    authToken: 'installation-token',
    worktreePath: '/worktree',
    octokit: {
      request: async <T>(endpoint: string, options: Record<string, unknown>) => {
        requests.push({ endpoint, options });
        return { data: { body: '![Desktop settings](https://github.com/user-attachments/assets/asset-id)' } } as T;
      }
    },
    runCommand: async options => {
      invocation = options;
      return { stdout: '' };
    }
  });

  assert.ok(invocation);
  assert.deepEqual(invocation.args.slice(0, 6), ['pr', 'edit', '42', '--repo', 'integry/propr', '--body']);
  assert.match(invocation.args[6], /!\[Desktop settings\]\(\/worktree\/\.propr\/previews\/desktop\.png\)/);
  assert.deepEqual(invocation.args.slice(-2), ['--attach', '/worktree/.propr/previews/desktop.png']);
  assert.equal(invocation.authToken, 'installation-token');
  assert.equal(invocation.args.includes('installation-token'), false);
  assert.deepEqual(requests.map(request => request.endpoint), ['GET /repos/{owner}/{repo}/pulls/{pull_number}']);
});

test('rejects a pull request upload when GitHub leaves a local path in the body', async () => {
  await assert.rejects(() => publishPullRequestVisualPreviews({
    owner: 'integry',
    repo: 'propr',
    pullRequestNumber: 42,
    body: 'Implementation summary',
    evidence,
    authToken: 'installation-token',
    worktreePath: '/worktree',
    octokit: {
      request: async <T>() => ({ data: { body: '![Desktop settings](/worktree/.propr/previews/desktop.png)' } }) as T
    },
    runCommand: async () => ({ stdout: '' })
  }), /did not replace a local visual preview path/);
});

test('uploads media before updating the existing work comment without creating another comment', async () => {
  const requests: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
  const uploads: Array<{ absolutePath: string; authToken: string; repositoryId: number }> = [];
  const published = await publishPullRequestCommentVisualPreviews({
    owner: 'integry',
    repo: 'propr',
    pullRequestNumber: 42,
    body: 'Follow-up complete',
    evidence,
    authToken: 'installation-token',
    worktreePath: '/worktree',
    startingCommentId: 100,
    octokit: {
      request: async <T>(endpoint: string, options: Record<string, unknown>) => {
        requests.push({ endpoint, options });
        if (endpoint === 'GET /repos/{owner}/{repo}') {
          return { data: { id: 987 } } as T;
        }
        if (endpoint.startsWith('PATCH ')) {
          return { data: {
            html_url: 'https://github.com/integry/propr/pull/42#issuecomment-100',
            body: options.body,
          } } as T;
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }
    },
    uploadAsset: async options => {
      uploads.push(options);
      return 'https://github.com/user-attachments/assets/asset-id';
    },
  });

  assert.equal(published.html_url, 'https://github.com/integry/propr/pull/42#issuecomment-100');
  assert.match(published.body, /https:\/\/github\.com\/user-attachments\/assets\/asset-id/);
  assert.doesNotMatch(published.body, /\/worktree\/\.propr\/previews/);
  assert.deepEqual(requests.map(request => request.endpoint), [
    'GET /repos/{owner}/{repo}',
    'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
  ]);
  assert.equal(requests[1].options.comment_id, 100);
  assert.deepEqual(uploads, [{
    absolutePath: '/worktree/.propr/previews/desktop.png',
    authToken: 'installation-token',
    repositoryId: 987,
  }]);
});

test('does not update the work comment when a direct attachment upload fails', async () => {
  const requests: string[] = [];
  await assert.rejects(() => publishPullRequestCommentVisualPreviews({
    owner: 'integry',
    repo: 'propr',
    pullRequestNumber: 42,
    body: 'Follow-up complete',
    evidence,
    authToken: 'installation-token',
    worktreePath: '/worktree',
    startingCommentId: 100,
    octokit: {
      request: async <T>(endpoint: string) => {
        requests.push(endpoint);
        return { data: { id: 987 } } as T;
      }
    },
    uploadAsset: async () => { throw new Error('attachment upload failed'); },
  }), /attachment upload failed/);

  assert.deepEqual(requests, ['GET /repos/{owner}/{repo}']);
});

test('rejects an updated work comment whose response still contains a local path', async () => {
  const requests: string[] = [];
  await assert.rejects(() => publishPullRequestCommentVisualPreviews({
    owner: 'integry',
    repo: 'propr',
    pullRequestNumber: 42,
    body: 'Follow-up complete',
    evidence,
    authToken: 'installation-token',
    worktreePath: '/worktree',
    startingCommentId: 100,
    octokit: {
      request: async <T>(endpoint: string, options: Record<string, unknown>) => {
        requests.push(endpoint);
        if (endpoint === 'GET /repos/{owner}/{repo}') {
          return { data: { id: 987 } } as T;
        }
        return { data: {
          html_url: 'https://github.com/integry/propr/pull/42#issuecomment-100',
          body: '![Desktop settings](/worktree/.propr/previews/desktop.png)',
          comment_id: options.comment_id,
        } } as T;
      }
    },
    uploadAsset: async () => 'https://github.com/user-attachments/assets/asset-id',
  }), /did not replace a local visual preview path/);

  assert.deepEqual(requests, [
    'GET /repos/{owner}/{repo}',
    'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
  ]);
});

test('uploads an attachment directly to the repository-scoped GitHub endpoint', async t => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'propr-upload-test-'));
  const assetPath = path.join(temporaryDirectory, 'desktop.png');
  const assetBody = Buffer.from('preview bytes');
  await writeFile(assetPath, assetBody);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://uploads.github.com');
    assert.equal(url.pathname, '/user-attachments/assets');
    assert.equal(url.searchParams.get('name'), 'desktop.png');
    assert.equal(url.searchParams.get('content_type'), 'image/png');
    assert.equal(url.searchParams.get('repository_id'), '987');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer preview-token');
    assert.deepEqual(Buffer.from(init?.body as Uint8Array), assetBody);
    return new Response(JSON.stringify({
      url: 'https://github.com/user-attachments/assets/direct-asset-id',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  });

  assert.equal(await uploadVisualPreviewAsset({
    absolutePath: assetPath,
    authToken: 'preview-token',
    repositoryId: 987,
  }), 'https://github.com/user-attachments/assets/direct-asset-id');
});

test('managed storage failure still publishes GitHub attachments without exposing its error', async () => {
  let attempted = false;
  let published = false;
  await publishPullRequestVisualPreviews({
    owner: 'integry', repo: 'propr', pullRequestNumber: 42, taskId: 'task-2285', body: 'Summary', evidence,
    authToken: 'gho_test', worktreePath: '/worktree',
    storeOriginals: async (originals, repository) => {
      assert.equal(originals, evidence);
      assert.deepEqual(repository, { taskId: 'task-2285', repository: 'integry/propr', pullRequestNumber: 42 });
      attempted = true;
      throw new Error('https://signed.example/?token=secret');
    },
    runCommand: async ({ args }) => {
      assert.equal(attempted, true);
      assert.ok(args.includes('--attach'));
      assert.ok(!args.join(' ').includes('signed.example'));
      published = true;
      return { stdout: '' };
    },
    octokit: { request: async <T>() => ({ data: { body: '![Preview](https://github.com/user-attachments/assets/1)' } }) as T },
  });
  assert.equal(published, true);
});


test('managed originals return ordered per-asset finalized metadata and bounded independent failures', async () => {
  const assets = ['first.png', 'broken.png', 'quota.mp4', 'unsupported.txt', 'last.webp'].map((name, index) => ({
    relativePath: `.propr/previews/${name}`, absolutePath: `/staged/${name}`, type: 'image' as const, title: `Asset ${index}`,
  }));
  const context = { taskId: 'task-2285', repository: 'integry/propr', pullRequestNumber: 2285 };
  const artifactFor = (displayFilename: string): PreviewArtifactV1 => ({
    version: 1, artifactId: displayFilename, state: 'ready', ...context, displayFilename,
    sizeBytes: 123, contentType: displayFilename.endsWith('webp') ? 'image/webp' : 'image/png', sha256: 'a'.repeat(64),
    viewerUrl: `https://connect.example.test/previews/${displayFilename}`, retentionExpiresAt: '2099-01-01T00:00:00Z',
  });
  const requests: string[] = [];
  const result = await storeManagedVisualPreviewOriginals({ assets, toolSuggestions: [] }, context, {
    createClient: () => ({ uploadOriginal: async input => {
      assert.equal(input.taskId, context.taskId);
      assert.equal(input.repository, context.repository);
      assert.equal(input.pullRequestNumber, context.pullRequestNumber);
      assert.equal('bytes' in input, false);
      assert.equal('installationId' in input, false);
      requests.push(input.filePath);
      if (input.displayFilename === 'broken.png') throw new Error('raw token=secret https://objects.example/?signed=secret');
      if (input.displayFilename === 'quota.mp4') return { stored: false, code: 'quota_exceeded' };
      return { stored: true, artifact: artifactFor(input.displayFilename) };
    } }),
  });
  assert.deepEqual(requests, ['/staged/first.png', '/staged/broken.png', '/staged/quota.mp4', '/staged/last.webp']);
  assert.deepEqual(result, assets.map((asset, assetIndex) => ({
    version: 1, assetIndex, relativePath: asset.relativePath,
    ...([0, 4].includes(assetIndex)
      ? { stored: true, artifact: artifactFor(assetIndex === 0 ? 'first.png' : 'last.webp') }
      : { stored: false, code: ['unavailable', 'quota_exceeded', 'content_type_not_allowed'][assetIndex - 1] }),
  })));
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(!JSON.stringify(result).includes('/staged/'));
  // Duplicate source paths remain independently addressable by index.
  const duplicates = await storeManagedVisualPreviewOriginals({ assets: [assets[0], assets[0]], toolSuggestions: [] }, context, {
    createClient: () => ({ uploadOriginal: async () => ({ stored: false, code: 'disabled' }) }),
  });
  assert.deepEqual(duplicates.map(result => result.assetIndex), [0, 1]);
});

test('managed client setup failure preserves a safe result for every asset', async () => {
  const result = await storeManagedVisualPreviewOriginals(evidence, { taskId: 'task-2285', repository: 'integry/propr' }, {
    createClient: () => { throw new Error('relay-token-secret'); },
  });
  assert.deepEqual(result, [{ version: 1, assetIndex: 0, relativePath: evidence.assets[0].relativePath, stored: false, code: 'unavailable' }]);
});
