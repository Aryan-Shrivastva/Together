import { useEffect, useState } from 'react';

type JoinState =
  | { status: 'joining' }
  | { status: 'joined'; workspaceName: string; repoFullName: string }
  | { status: 'error'; message: string };

function getErrorMessage(payload: unknown): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof payload.error === 'string'
  ) {
    return payload.error;
  }

  return 'Unable to join this workspace.';
}

export function JoinWorkspace({ token }: { token: string }) {
  const [joinState, setJoinState] = useState<JoinState>({ status: 'joining' });

  useEffect(() => {
    const controller = new AbortController();

    async function joinWorkspace() {
      try {
        const response = await fetch(`/api/join/${encodeURIComponent(token)}`, {
          method: 'POST',
          credentials: 'include',
          signal: controller.signal,
        });
        const payload: unknown = await response.json();

        if (!response.ok) {
          throw new Error(getErrorMessage(payload));
        }

        if (
          typeof payload !== 'object' ||
          payload === null ||
          !('workspace' in payload) ||
          typeof payload.workspace !== 'object' ||
          payload.workspace === null ||
          !('name' in payload.workspace) ||
          typeof payload.workspace.name !== 'string' ||
          !('repoFullName' in payload.workspace) ||
          typeof payload.workspace.repoFullName !== 'string'
        ) {
          throw new Error('The join response was invalid.');
        }

        setJoinState({
          status: 'joined',
          workspaceName: payload.workspace.name,
          repoFullName: payload.workspace.repoFullName,
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          setJoinState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unable to join this workspace.',
          });
        }
      }
    }

    void joinWorkspace();

    return () => controller.abort();
  }, [token]);

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100">
      <section className="mx-auto max-w-xl rounded-xl border border-slate-800 bg-slate-900 p-8 shadow-2xl">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300">Together</p>
        {joinState.status === 'joining' ? (
          <>
            <h1 className="font-display mt-3 text-5xl text-slate-50">Joining workspace</h1>
            <p className="mt-4 text-slate-300">Checking your invite and adding you to the team.</p>
          </>
        ) : null}
        {joinState.status === 'joined' ? (
          <>
            <h1 className="font-display mt-3 text-5xl text-slate-50">
              You joined {joinState.workspaceName}
            </h1>
            <p className="mt-4 text-slate-300">
              You can now access {joinState.repoFullName} from your dashboard.
            </p>
            <button
              className="mt-6 rounded-md bg-cyan-400 px-4 py-2 font-semibold text-slate-950 hover:bg-cyan-300"
              type="button"
              onClick={() => window.location.assign('/')}
            >
              Go to dashboard
            </button>
          </>
        ) : null}
        {joinState.status === 'error' ? (
          <>
            <h1 className="font-display mt-3 text-5xl text-slate-50">Unable to join workspace</h1>
            <p className="mt-4 text-rose-300">{joinState.message}</p>
            <button
              className="mt-6 rounded-md border border-slate-600 px-4 py-2 font-semibold text-slate-100 hover:border-slate-400"
              type="button"
              onClick={() => window.location.assign('/')}
            >
              Go to dashboard
            </button>
          </>
        ) : null}
      </section>
    </main>
  );
}
