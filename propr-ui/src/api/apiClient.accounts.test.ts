import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch, setApiBaseUrl, setDesktopConnectionScope } from './apiClient';

const scope = (id: string) => ({ bridge: {} as never, profileId: id, transportScope: id.repeat(22) });
afterEach(() => { setDesktopConnectionScope(null); vi.restoreAllMocks(); });

it('aborts old requests and rejects late success from the same endpoint after A → B → A', async () => {
  setApiBaseUrl('https://team.test');
  setDesktopConnectionScope(scope('a'));
  let complete!: (response: Response) => void;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const pending = apiFetch('/api/tasks');
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const init = fetch.mock.calls[0][1];
  setDesktopConnectionScope(scope('b'));
  setDesktopConnectionScope(scope('a'));
  expect(init?.signal?.aborted).toBe(true);
  complete(new Response(JSON.stringify({ private: 'alice' })));
  await rejected;
});

it('rejects a response body and its clone when decoding finishes after switching', async () => {
  setDesktopConnectionScope(scope('a'));
  let finish!: () => void;
  const data = new ReadableStream({ start(controller) {
    finish = () => { controller.enqueue(new TextEncoder().encode('{"private":"alice"}')); controller.close(); };
  } });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(data));
  const response = await apiFetch('/api/tasks');
  const copy = response.clone();
  const originalBody = expect(response.json()).rejects.toMatchObject({ name: 'AbortError' });
  const clonedBody = expect(copy.json()).rejects.toMatchObject({ name: 'AbortError' });
  setDesktopConnectionScope(scope('b'));
  finish();
  await Promise.all([originalBody, clonedBody]);
});
