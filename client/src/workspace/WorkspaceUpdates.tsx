import { useCallback, useEffect, useRef, useState } from 'react';

type VersionUpdate = {
  id: string;
  action: string;
  details: string | null;
  createdAt: string;
  user: { id: string; username: string } | null;
};
type UpdateSummary = { unseenCount: number; updates: VersionUpdate[] };

async function request(path: string, body?: { activityId: string }) {
  const response = await fetch(path, {
    credentials: 'include',
    ...(body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  if (!response.ok) throw new Error('Unable to check workspace versions. Please retry.');
  return response.status === 204 ? null : response.json();
}

export function WorkspaceUpdates({
  workspaceId,
  checkKey,
  onRefresh,
}: {
  workspaceId: string;
  checkKey: number;
  onRefresh: () => Promise<void>;
}) {
  const [summary, setSummary] = useState<UpdateSummary>({ unseenCount: 0, updates: [] });
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const requestSequence = useRef({ value: 0 });
  const load = useCallback(async () => {
    const sequence = ++requestSequence.current.value;
    try {
      const result = (await request(`/api/workspaces/${workspaceId}/versions`)) as UpdateSummary;
      if (sequence !== requestSequence.current.value) return;
      setSummary(result);
      setError(null);
    } catch (cause) {
      if (sequence === requestSequence.current.value) setError((cause as Error).message);
    }
  }, [workspaceId]);

  useEffect(() => {
    const pendingRequests = requestSequence.current;
    void load();
    // Recheck after disconnections or when returning to an inactive tab.
    const checkVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const interval = window.setInterval(checkVisible, 30_000);
    window.addEventListener('focus', checkVisible);
    window.addEventListener('online', checkVisible);
    document.addEventListener('visibilitychange', checkVisible);
    return () => {
      ++pendingRequests.value;
      window.clearInterval(interval);
      window.removeEventListener('focus', checkVisible);
      window.removeEventListener('online', checkVisible);
      document.removeEventListener('visibilitychange', checkVisible);
    };
  }, [load, checkKey]);

  async function refresh() {
    const latestReviewed = summary.updates[0];
    if (!latestReviewed) return;
    setRefreshing(true);
    setError(null);
    try {
      await onRefresh();
      await request(`/api/workspaces/${workspaceId}/versions/reviewed`, {
        activityId: latestReviewed.id,
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not refresh the workspace.');
    } finally {
      setRefreshing(false);
    }
  }

  if (!summary.unseenCount && !error) return null;
  return (
    <section
      aria-label="Workspace version updates"
      className="max-h-56 shrink-0 overflow-auto border-b border-amber-400/30 bg-gradient-to-r from-[#3b3020] to-[#242724] px-5 py-3 text-xs text-amber-100"
    >
      {summary.unseenCount > 0 ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div role="status" aria-live="polite">
              <p className="font-semibold">
                {summary.unseenCount} new shared{' '}
                {summary.unseenCount === 1 ? 'version' : 'versions'} to review
              </p>
              <p className="mt-1 text-amber-100/80">
                Teammates saved changes since your last review. Refresh the workspace before
                continuing.
              </p>
            </div>
            <button
              type="button"
              disabled={refreshing}
              onClick={() => void refresh()}
              className="rounded-lg bg-amber-200 px-4 py-2 font-semibold text-[#211b12] shadow-lg shadow-amber-950/20 transition hover:bg-amber-100 disabled:opacity-50"
            >
              {refreshing ? 'Refreshing…' : 'Refresh workspace'}
            </button>
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer">See who changed what</summary>
            <ul className="mt-2 space-y-2">
              {summary.updates.map((update) => (
                <li key={update.id}>
                  <span className="font-semibold">{update.user?.username ?? 'A teammate'}</span>{' '}
                  {update.action === 'git.committed'
                    ? 'committed'
                    : update.action === 'branch.merged'
                      ? 'merged a task branch'
                      : 'pulled changes from GitHub'}
                  {update.details ? `: ${update.details}` : ''}
                  <time dateTime={update.createdAt} className="ml-2 text-amber-100/60">
                    {new Date(update.createdAt).toLocaleString()}
                  </time>
                </li>
              ))}
            </ul>
            {summary.unseenCount > summary.updates.length ? (
              <p className="mt-2">Showing the latest 20 updates.</p>
            ) : null}
          </details>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2">
          {error}{' '}
          <button type="button" className="underline" onClick={() => void load()}>
            Check again
          </button>
        </p>
      ) : null}
    </section>
  );
}
