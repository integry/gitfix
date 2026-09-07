import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import type { Job, Queue } from 'bullmq';
import { isDemoMode } from '../demoMode.js';

export const ACTIVE_WORK_DEFINITION =
  'Running tasks + generating or refining plans + standalone incomplete goals';

interface ActiveWorkRoutesDependencies {
  db: Knex;
  taskQueue: Pick<Queue, 'getJobs'>;
}

interface CountRow {
  count?: string | number;
}

const countActiveJobs = (jobs: readonly Pick<Job, 'id'>[]): number => {
  const ids = new Set<string>();
  for (const job of jobs) {
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
 * Goals are uncompleted repository todos which have not been converted into a
 * plan. Excluding linked goals makes the three categories disjoint.
 */
export const createActiveWorkRoutes = ({ db, taskQueue }: ActiveWorkRoutesDependencies) => ({
  async getActiveWork(req: Request, res: Response): Promise<void> {
    if (!req.user?.id) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    try {
      let plansQuery = db('task_drafts')
        .count('* as count')
        .whereIn('status', ['generating', 'refining']);
      let goalsQuery = db('repo_todos')
        .count('* as count')
        .where({ is_completed: false })
        .whereNull('linked_draft_id');
      if (!isDemoMode()) {
        plansQuery = plansQuery.andWhere({ user_id: req.user.id });
        goalsQuery = goalsQuery.andWhere({ user_id: req.user.id });
      }

      const [activeJobs, planRow, goalRow] = await Promise.all([
        taskQueue.getJobs(['active']),
        plansQuery.first() as Promise<CountRow | undefined>,
        goalsQuery.first() as Promise<CountRow | undefined>,
      ]);
      const tasks = countActiveJobs(activeJobs);
      const plans = rowCount(planRow);
      const goals = rowCount(goalRow);

      res.json({
        schemaVersion: 1,
        label: 'Active work',
        definition: ACTIVE_WORK_DEFINITION,
        counts: { tasks, plans, goals, total: tasks + plans + goals },
      });
    } catch (error) {
      console.error('Error in /api/desktop/active-work:', error);
      res.status(500).json({ error: 'Failed to fetch active work' });
    }
  },
});

