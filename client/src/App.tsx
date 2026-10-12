import { useEffect, useState } from 'react';

import { AuthProvider, useAuth } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { Dashboard } from './dashboard/Dashboard';
import { JoinWorkspace } from './invites/JoinWorkspace';
import { WorkspaceExplorer } from './workspace/WorkspaceExplorer';

type HealthState = 'checking' | 'available' | 'unavailable';

function LoginScreen({ health }: { health: HealthState }) {
  const { error, signIn } = useAuth();

  return (
    <section className="mx-auto max-w-2xl rounded-xl border border-slate-800 bg-slate-900 p-8 shadow-2xl">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-400">Together</p>
      <h1 className="mt-3 text-3xl font-bold">Collaborative development workspace</h1>
      <p className="mt-4 text-slate-300">Sign in with GitHub to continue.</p>
      {error ? <p className="mt-4 text-sm text-rose-300">{error}</p> : null}
      <button
        className="mt-6 rounded-md bg-cyan-400 px-4 py-2 font-semibold text-slate-950 hover:bg-cyan-300"
        type="button"
        onClick={signIn}
      >
        Sign in with GitHub
      </button>
      <p className="mt-6 text-sm" aria-live="polite">
        Backend health: <span className="font-semibold">{health}</span>
      </p>
    </section>
  );
}

function AuthenticatedApp() {
  const [health, setHealth] = useState<HealthState>('checking');
  const joinToken = /^\/join\/([A-Za-z0-9_-]{43})$/.exec(window.location.pathname)?.[1];
  const workspaceId = /^\/workspaces\/([0-9a-f-]{36})$/i.exec(window.location.pathname)?.[1];

  useEffect(() => {
    const controller = new AbortController();

    async function checkHealth() {
      try {
        const response = await fetch('/health', { signal: controller.signal });
        setHealth(response.ok ? 'available' : 'unavailable');
      } catch {
        if (!controller.signal.aborted) {
          setHealth('unavailable');
        }
      }
    }

    void checkHealth();

    return () => controller.abort();
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100">
      <ProtectedRoute fallback={<LoginScreen health={health} />}>
        {joinToken ? (
          <JoinWorkspace token={joinToken} />
        ) : workspaceId ? (
          <WorkspaceExplorer workspaceId={workspaceId} />
        ) : (
          <Dashboard />
        )}
      </ProtectedRoute>
    </main>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  );
}
