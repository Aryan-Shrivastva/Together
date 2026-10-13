import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAuth } from '../auth/AuthContext';

type Repository = {
  fullName: string;
  name: string;
  isPrivate: boolean;
  defaultBranch: string;
};

type Workspace = {
  id: string;
  name: string;
  repoFullName: string;
  defaultBranch: string;
  status: 'CLONING' | 'READY' | 'ERROR';
  createdAt: string;
  role: 'OWNER' | 'COLLABORATOR';
  errorMessage?: string;
};

type WorkspaceInvite = {
  id: string;
  link: string;
  expiresAt: string;
};

function getErrorMessage(payload: unknown): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof payload.error === 'string'
  ) {
    return payload.error;
  }

  return 'Something went wrong. Please try again.';
}

async function requestJson(path: string, options?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...options, credentials: 'include' });
  const payload: unknown = response.status === 204 ? null : await response.json();

  if (!response.ok) {
    throw new Error(getErrorMessage(payload));
  }

  return payload;
}

function isWorkspace(value: unknown): value is Workspace {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'status' in value &&
    (value.status === 'CLONING' || value.status === 'READY' || value.status === 'ERROR')
  );
}

function isRepository(value: unknown): value is Repository {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fullName' in value &&
    typeof value.fullName === 'string' &&
    'name' in value &&
    typeof value.name === 'string'
  );
}

function isWorkspaceInvite(value: unknown): value is WorkspaceInvite {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'link' in value &&
    typeof value.link === 'string' &&
    'expiresAt' in value &&
    typeof value.expiresAt === 'string'
  );
}

export function Dashboard() {
  const { signOut, user } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [isLoadingRepositories, setIsLoadingRepositories] = useState(false);
  const [selectedRepository, setSelectedRepository] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [invitesByWorkspace, setInvitesByWorkspace] = useState<Record<string, WorkspaceInvite>>({});
  const [inviteErrorsByWorkspace, setInviteErrorsByWorkspace] = useState<Record<string, string>>(
    {},
  );
  const [creatingInviteWorkspaceId, setCreatingInviteWorkspaceId] = useState<string | null>(null);
  const [copiedInviteWorkspaceId, setCopiedInviteWorkspaceId] = useState<string | null>(null);

  const hasCloningWorkspace = useMemo(
    () => workspaces.some((workspace) => workspace.status === 'CLONING'),
    [workspaces],
  );

  const loadWorkspaces = useCallback(async () => {
    try {
      const payload = await requestJson('/api/workspaces');

      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('workspaces' in payload) ||
        !Array.isArray(payload.workspaces)
      ) {
        throw new Error('The workspace response was invalid.');
      }

      setWorkspaces(payload.workspaces.filter(isWorkspace));
      setWorkspaceError(null);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : 'Unable to load workspaces.');
    } finally {
      setIsLoadingWorkspaces(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    if (!hasCloningWorkspace) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      void loadWorkspaces();
    }, 2_000);

    return () => window.clearInterval(interval);
  }, [hasCloningWorkspace, loadWorkspaces]);

  async function openWorkspaceModal() {
    setIsModalOpen(true);
    setCreateError(null);
    setIsLoadingRepositories(true);

    try {
      const payload = await requestJson('/api/repos');

      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('repositories' in payload) ||
        !Array.isArray(payload.repositories)
      ) {
        throw new Error('The repository response was invalid.');
      }

      const availableRepositories = payload.repositories.filter(isRepository);
      setRepositories(availableRepositories);
      setSelectedRepository(
        (currentRepository) => currentRepository || availableRepositories[0]?.fullName || '',
      );
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Unable to load repositories.');
    } finally {
      setIsLoadingRepositories(false);
    }
  }

  async function createWorkspace() {
    if (!selectedRepository) {
      setCreateError('Choose a repository first.');
      return;
    }

    setIsCreating(true);
    setCreateError(null);

    try {
      await requestJson('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoFullName: selectedRepository }),
      });
      setIsModalOpen(false);
      await loadWorkspaces();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Unable to create workspace.');
    } finally {
      setIsCreating(false);
    }
  }

  async function handleSignOut() {
    setSignOutError(null);

    try {
      await signOut();
    } catch {
      setSignOutError('Unable to sign out. Please try again.');
    }
  }

  async function createInvite(workspaceId: string) {
    setCreatingInviteWorkspaceId(workspaceId);
    setInviteErrorsByWorkspace((errors) => ({ ...errors, [workspaceId]: '' }));

    try {
      const payload = await requestJson(`/api/workspaces/${workspaceId}/invites`, {
        method: 'POST',
      });

      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('invite' in payload) ||
        !isWorkspaceInvite(payload.invite)
      ) {
        throw new Error('The invite response was invalid.');
      }

      const invite = payload.invite;
      setInvitesByWorkspace((invites) => ({ ...invites, [workspaceId]: invite }));
    } catch (error) {
      setInviteErrorsByWorkspace((errors) => ({
        ...errors,
        [workspaceId]: error instanceof Error ? error.message : 'Unable to create an invite link.',
      }));
    } finally {
      setCreatingInviteWorkspaceId(null);
    }
  }

  async function copyInvite(workspaceId: string) {
    const invite = invitesByWorkspace[workspaceId];

    if (!invite) {
      return;
    }

    try {
      await navigator.clipboard.writeText(invite.link);
      setCopiedInviteWorkspaceId(workspaceId);
    } catch {
      setInviteErrorsByWorkspace((errors) => ({
        ...errors,
        [workspaceId]: 'Copy the invite link from the field below.',
      }));
    }
  }

  async function revokeInvite(workspaceId: string) {
    const invite = invitesByWorkspace[workspaceId];

    if (!invite) {
      return;
    }

    try {
      await requestJson(`/api/workspaces/${workspaceId}/invites/${invite.id}`, {
        method: 'DELETE',
      });
      setInvitesByWorkspace((invites) => {
        const nextInvites = { ...invites };
        delete nextInvites[workspaceId];
        return nextInvites;
      });
      setCopiedInviteWorkspaceId(null);
    } catch (error) {
      setInviteErrorsByWorkspace((errors) => ({
        ...errors,
        [workspaceId]: error instanceof Error ? error.message : 'Unable to revoke this invite.',
      }));
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <section className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-6">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300">
              Together
            </p>
            <h1 className="font-display mt-2 text-5xl text-slate-50">Your workspaces</h1>
          </div>
          <div className="flex items-center gap-3">
            {user?.avatarUrl ? (
              <img
                className="h-9 w-9 rounded-full"
                src={user.avatarUrl}
                alt=""
                referrerPolicy="no-referrer"
              />
            ) : null}
            <span className="text-sm text-slate-300">{user?.username}</span>
            <button
              className="text-sm text-slate-300 hover:text-white"
              type="button"
              onClick={() => void handleSignOut()}
            >
              Sign out
            </button>
          </div>
        </header>

        <div className="mt-8 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Repositories cloned for your team</h2>
            <p className="mt-1 text-sm text-slate-400">
              Create a workspace from a repository you can access on GitHub.
            </p>
          </div>
          <button
            className="rounded-md bg-cyan-400 px-4 py-2 font-semibold text-slate-950 hover:bg-cyan-300"
            type="button"
            onClick={() => void openWorkspaceModal()}
          >
            New workspace
          </button>
        </div>

        {signOutError ? <p className="mt-4 text-sm text-rose-300">{signOutError}</p> : null}
        {workspaceError ? <p className="mt-4 text-sm text-rose-300">{workspaceError}</p> : null}

        {isLoadingWorkspaces ? <p className="mt-10 text-slate-400">Loading workspaces…</p> : null}
        {!isLoadingWorkspaces && workspaces.length === 0 ? (
          <p className="mt-10 rounded-lg border border-dashed border-slate-700 p-8 text-slate-400">
            No workspaces yet. Create one from GitHub to begin.
          </p>
        ) : null}

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((workspace) => {
            const invite = invitesByWorkspace[workspace.id];

            return (
              <article
                key={workspace.id}
                className="rounded-lg border border-slate-800 bg-slate-900 p-5"
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-semibold">{workspace.name}</h3>
                  <span className="rounded-full bg-slate-800 px-2 py-1 text-xs text-slate-300">
                    {workspace.status}
                  </span>
                </div>
                <p className="mt-3 text-sm text-slate-400">{workspace.repoFullName}</p>
                <p className="mt-2 text-xs text-slate-500">Branch: {workspace.defaultBranch}</p>
                {workspace.status === 'CLONING' ? (
                  <p className="mt-4 text-sm text-cyan-300">Cloning repository…</p>
                ) : null}
                {workspace.errorMessage ? (
                  <p className="mt-4 text-sm text-rose-300">{workspace.errorMessage}</p>
                ) : null}
                {workspace.status === 'READY' ? (
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <p className="text-sm text-emerald-300">Workspace ready</p>
                    <button
                      className="rounded-md bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300"
                      type="button"
                      onClick={() => window.location.assign(`/workspaces/${workspace.id}`)}
                    >
                      Open files
                    </button>
                  </div>
                ) : null}
                {workspace.role === 'OWNER' ? (
                  <div className="mt-4 border-t border-slate-800 pt-4">
                    <button
                      className="rounded-md border border-cyan-400 px-3 py-2 text-sm font-semibold text-cyan-300 hover:bg-cyan-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                      type="button"
                      disabled={creatingInviteWorkspaceId === workspace.id}
                      onClick={() => void createInvite(workspace.id)}
                    >
                      {creatingInviteWorkspaceId === workspace.id
                        ? 'Creating invite…'
                        : 'Invite teammate'}
                    </button>
                    {invite ? (
                      <div className="mt-3 space-y-2">
                        <label
                          className="block text-xs text-slate-400"
                          htmlFor={`invite-${workspace.id}`}
                        >
                          Invite link (expires {new Date(invite.expiresAt).toLocaleString()})
                        </label>
                        <input
                          className="w-full rounded-md border border-slate-700 bg-slate-950 p-2 text-xs text-slate-200"
                          id={`invite-${workspace.id}`}
                          readOnly
                          value={invite.link}
                        />
                        <div className="flex gap-3 text-sm">
                          <button
                            className="font-semibold text-cyan-300 hover:text-cyan-200"
                            type="button"
                            onClick={() => void copyInvite(workspace.id)}
                          >
                            {copiedInviteWorkspaceId === workspace.id ? 'Copied' : 'Copy link'}
                          </button>
                          <button
                            className="font-semibold text-rose-300 hover:text-rose-200"
                            type="button"
                            onClick={() => void revokeInvite(workspace.id)}
                          >
                            Revoke link
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {inviteErrorsByWorkspace[workspace.id] ? (
                      <p className="mt-3 text-sm text-rose-300">
                        {inviteErrorsByWorkspace[workspace.id]}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      {isModalOpen ? (
        <div
          className="fixed inset-0 grid place-items-center bg-slate-950/80 px-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="workspace-dialog-title"
        >
          <section className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
            <h2 id="workspace-dialog-title" className="text-xl font-semibold">
              Create workspace
            </h2>
            <p className="mt-2 text-sm text-slate-400">
              Select a GitHub repository to clone into the shared workspace.
            </p>
            <label className="mt-6 block text-sm font-medium" htmlFor="repository">
              Repository
            </label>
            <select
              id="repository"
              className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 p-3 text-slate-100"
              value={selectedRepository}
              disabled={isLoadingRepositories || isCreating}
              onChange={(event) => setSelectedRepository(event.target.value)}
            >
              {repositories.length === 0 ? (
                <option value="">No repositories available</option>
              ) : null}
              {repositories.map((repository) => (
                <option key={repository.fullName} value={repository.fullName}>
                  {repository.fullName} {repository.isPrivate ? '(private)' : ''}
                </option>
              ))}
            </select>
            {isLoadingRepositories ? (
              <p className="mt-3 text-sm text-slate-400">Loading repositories…</p>
            ) : null}
            {createError ? <p className="mt-3 text-sm text-rose-300">{createError}</p> : null}
            <div className="mt-6 flex justify-end gap-3">
              <button
                className="rounded-md px-4 py-2 text-slate-300 hover:text-white"
                type="button"
                disabled={isCreating}
                onClick={() => setIsModalOpen(false)}
              >
                Cancel
              </button>
              <button
                className="rounded-md bg-cyan-400 px-4 py-2 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                type="button"
                disabled={isLoadingRepositories || !selectedRepository || isCreating}
                onClick={() => void createWorkspace()}
              >
                {isCreating ? 'Creating…' : 'Clone repository'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
