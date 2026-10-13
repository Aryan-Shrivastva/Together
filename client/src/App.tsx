import { lazy, Suspense, useEffect, useState } from 'react';

import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { Dashboard } from './dashboard/Dashboard';
import { JoinWorkspace } from './invites/JoinWorkspace';
import { Landing } from './landing/Landing';

const WorkspaceExplorer = lazy(async () => ({
  default: (await import('./workspace/WorkspaceExplorer')).WorkspaceExplorer,
}));

type HealthState = 'checking' | 'available' | 'unavailable';

function WorkspaceLoadingScreen() {
  return (
    <section className="glass mx-auto max-w-3xl rounded-3xl p-8">
      <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-300">
        Together
      </p>
      <h1 className="font-display mt-3 text-4xl text-slate-50">Opening workspace</h1>
      <p className="mt-3 text-slate-300">Loading the editor and collaboration tools.</p>
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
    <div className="min-h-screen text-slate-100">
      <ProtectedRoute fallback={<Landing health={health} />}>
        {joinToken ? (
          <JoinWorkspace token={joinToken} />
        ) : workspaceId ? (
          <Suspense
            fallback={
              <div className="px-6 py-16">
                <WorkspaceLoadingScreen />
              </div>
            }
          >
            <WorkspaceExplorer workspaceId={workspaceId} />
          </Suspense>
        ) : (
          <Dashboard />
        )}
      </ProtectedRoute>
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  );
}
