import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import type { Job, Queue } from 'bullmq';
import { isDemoMode } from '../demoMode.js';

export const ACTIVE_WORK_DEFINITION =
  'Running tasks + generating or refining plans; open goals are reported separately';

interface ActiveWorkRoutesDependencies {
  db: Knex;
  taskQueue: Pick<Queue, 'getJobs'>;
}

interface CountRow {
  count?: string | number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const countActiveJobs = (
  jobs: readonly Pick<Job, 'id' | 'data'>[],
  userId: string,
  sharedInstance: boolean,
): number => {
  const ids = new Set<string>();
  for (const job of jobs) {
    if (!sharedInstance && (!isRecord(job.data) || job.data.userId !== userId)) continue;
    if (typeof job.id === 'string' && job.id.length > 0) ids.add(job.id);
  }
  return ids.size;
};

const rowCount = (row: CountRow | undefined): number => {
  const count = Number(row?.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Active work query returned an invalid count');
  }
  return count;
};

/**
 * A single authenticated reconciliation snapshot for native desktop surfaces.
 * This branch has no authoritative executing state for goals. Standalone
 * incomplete repository todos are therefore reported as open backlog, never
 * as active work. Queue jobs without authoritative recipient metadata fail
 * closed outside the explicitly shared demo instance.
 */
export const createActiveWorkRoutes = ({ db, taskQueue }: ActiveWorkRoutesDependencies) => ({
  async getActiveWork(req: Request, res: Response): Promise<void> {
    if (!req.user?.id) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    try {
      const sharedInstance = isDemoMode();
      let plansQuery = db('task_drafts')
        .count('* as count')
        .whereIn('status', ['generating', 'refining']);
      let openGoalsQuery = db('repo_todos')
        .count('* as count')
        .where({ is_completed: false })
        .whereNull('linked_draft_id');
      if (!sharedInstance) {
        plansQuery = plansQuery.andWhere({ user_id: req.user.id });
        openGoalsQuery = openGoalsQuery.andWhere({ user_id: req.user.id });
      }

      const [activeJobs, planRow, openGoalRow] = await Promise.all([
        taskQueue.getJobs(['active']),
        plansQuery.first() as Promise<CountRow | undefined>,
        openGoalsQuery.first() as Promise<CountRow | undefined>,
      ]);
      const tasks = countActiveJobs(activeJobs, req.user.id, sharedInstance);
      const plans = rowCount(planRow);
      const openGoals = rowCount(openGoalRow);

      res.json({
        schemaVersion: 2,
        label: 'Active work',
        definition: ACTIVE_WORK_DEFINITION,
        availability: {
          tasks: 'available',
          plans: 'available',
          goals: 'unsupported',
          openGoals: 'available',
        },
        counts: { tasks, plans, goals: null, openGoals, total: tasks + plans },
      });
    } catch (error) {
      console.error('Error in /api/desktop/active-work:', error);
      res.status(500).json({ error: 'Failed to fetch active work' });
    }
  },
});
