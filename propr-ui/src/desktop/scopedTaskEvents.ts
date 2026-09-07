import { TASK_UPDATE, type TaskUpdatePayload } from '@propr/shared';
import type { DesktopTaskTransition } from '../../../apps/desktop/src/shared/contract';

/**
 * Shared renderer boundary for desktop consumers such as notifications and the tray.
 * It deliberately projects the existing authenticated SocketProvider event instead
 * of allowing desktop features to open their own transport or forward metadata.
 */
// The validation is intentionally exhaustive because this is the native IPC projection boundary.
// eslint-disable-next-line complexity
export const normalizeScopedDesktopTaskTransition = (payload: TaskUpdatePayload): DesktopTaskTransition | null => {
  if (payload.eventType !== TASK_UPDATE
    || typeof payload.taskId !== 'string' || payload.taskId.length < 1 || payload.taskId.length > 512
    || typeof payload.state !== 'string' || payload.state.length < 1 || payload.state.length > 64
    || typeof payload.previousState !== 'string' || payload.previousState.length < 1
    || payload.previousState.length > 64
    || typeof payload.timestamp !== 'string' || Number.isNaN(Date.parse(payload.timestamp))) return null;
  if (payload.repository !== undefined && (
    payload.repository.length > 201
    || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(payload.repository)
  )) return null;
  if (payload.issueNumber !== undefined && (
    !Number.isSafeInteger(payload.issueNumber) || payload.issueNumber < 1
  )) return null;
  if (payload.version !== undefined && (
    !Number.isSafeInteger(payload.version) || payload.version < 0
  )) return null;
  return {
    taskId: payload.taskId,
    state: payload.state,
    previousState: payload.previousState,
    timestamp: payload.timestamp,
    ...(payload.repository === undefined ? {} : { repository: payload.repository }),
    ...(payload.issueNumber === undefined ? {} : { issueNumber: payload.issueNumber }),
    ...(payload.version === undefined ? {} : { version: payload.version }),
  };
};
