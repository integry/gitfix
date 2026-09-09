import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { publishGoalVisualPreviews } from '../src/jobs/goalVisualPreviewPublisher.ts';

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

test('goal preview publication preserves an orchestrated PR body and replaces its preview section', async () => {
  const requests: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
  const octokit = {
    request: async (endpoint: string, options: Record<string, unknown>) => {
      requests.push({ endpoint, options });
      if (endpoint.startsWith('GET ')) {
        return {
          data: {
            body: [
              'Original orchestrated implementation summary.',
              '',
              '---',
              '',
              '<!-- propr-visual-preview -->',
              '## Visual preview',
              '',
              '### Previous',
              '',
              '![Previous](https://github.com/user-attachments/assets/previous)',
            ].join('\n'),
          },
        };
      }
      return { data: {} };
    },
  };

  await publishGoalVisualPreviews({
    goal_id: 'goal-1',
    repository: 'acme/repo',
    objective: 'Ship it',
    checkpoint_interval_minutes: null,
    worktree_path: '/tmp/worktree',
  }, { number: 42 }, {
    evidence: {
      assets: [],
      toolSuggestions: [{ name: 'Playwright Chromium', reason: 'Needed to capture the running UI.' }],
    },
  }, octokit as never);

  assert.equal(requests.length, 2);
  assert.equal(requests[1].endpoint, 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}');
  const body = String(requests[1].options.body);
  assert.match(body, /^Original orchestrated implementation summary\./);
  assert.doesNotMatch(body, /### Previous/);
  assert.match(body, /Playwright Chromium/);
  assert.equal(body.match(/<!-- propr-visual-preview -->/g)?.length, 1);
});
