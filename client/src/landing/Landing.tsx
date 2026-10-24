import { useEffect, useState } from 'react';

import { useAuth } from '../auth/AuthContext';

type HealthState = 'checking' | 'available' | 'unavailable';

const steps = [
  {
    index: '01',
    title: 'Sign in with GitHub',
    body: 'Your session stays in an httpOnly cookie. The GitHub token never reaches the browser.',
  },
  {
    index: '02',
    title: 'Clone a repository',
    body: 'Pick a repo you can access. Together clones it onto the shared server workspace.',
  },
  {
    index: '03',
    title: 'Invite the team',
    body: 'The owner shares a link. Teammates sign in and join as collaborators.',
  },
  {
    index: '04',
    title: 'Edit, then push',
    body: 'Type in the same file at once, chat beside the code, then commit and push from the workspace.',
  },
];

const capabilities = [
  {
    title: 'Live editing',
    body: 'Monaco tabs with conflict-free editing, remote cursors, and names for everyone in the file.',
  },
  {
    title: 'One file tree',
    body: 'Create, rename, move, and delete files. The rest of the team sees the tree update immediately.',
  },
  {
    title: 'Presence and chat',
    body: 'See who is online and which file they have open. Chat history stays after a refresh.',
  },
  {
    title: 'Source control',
    body: 'Review status, commit every change, pull, and let the owner push to the current branch.',
  },
];

function githubSignInPath(): string {
  const params = new URLSearchParams(window.location.search);
  params.delete('auth');
  const search = params.toString();
  const returnTo = `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`;
  return `/auth/github?returnTo=${encodeURIComponent(returnTo)}`;
}

export function Landing({ health }: { health: HealthState }) {
  const { error } = useAuth();
  const [authOutcome] = useState(() => new URLSearchParams(window.location.search).get('auth'));
  const isInvite = window.location.pathname.startsWith('/join/');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    if (!params.has('auth')) {
      return;
    }

    params.delete('auth');
    const search = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
    );
  }, []);
  const signInPath = githubSignInPath();
  const healthLabel =
    health === 'checking' ? 'Checking API' : health === 'available' ? 'API online' : 'API offline';

  return (
    <div className="relative min-h-screen overflow-hidden text-slate-100">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,213,106,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(255,213,106,0.14) 1px, transparent 1px)',
          backgroundSize: '72px 72px',
          maskImage: 'radial-gradient(ellipse at 50% 20%, black, transparent 75%)',
        }}
      />

      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-6">
        <a className="flex items-baseline gap-3" href="/">
          <span className="font-display text-3xl leading-none tracking-tight text-slate-50">
            Together
          </span>
          <span className="hidden text-[11px] uppercase tracking-[0.28em] text-slate-400 sm:inline">
            Shared workspace
          </span>
        </a>
        <div className="flex items-center gap-3">
          <span
            className="hidden items-center gap-2 rounded-full border border-slate-700 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-slate-400 sm:inline-flex"
            aria-live="polite"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${health === 'available' ? 'bg-cyan-300' : health === 'unavailable' ? 'bg-rose-300' : 'bg-slate-500'}`}
            />
            {healthLabel}
          </span>
          <a
            className="rounded-full bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-200"
            href={signInPath}
          >
            Sign in with GitHub
          </a>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-6xl px-6 pb-20 pt-8 sm:pt-16">
        {isInvite ? (
          <p className="mb-8 max-w-2xl rounded-2xl border border-cyan-400/40 bg-cyan-400/10 px-4 py-3 text-sm text-cyan-100">
            This invite needs a GitHub account. Sign in, and Together will add you to the workspace.
          </p>
        ) : null}
        {authOutcome === 'failed' ? (
          <p className="mb-8 max-w-2xl rounded-2xl border border-rose-400/50 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            GitHub sign-in did not finish. Start again from the button below.
          </p>
        ) : null}
        {error ? (
          <p className="mb-8 max-w-2xl rounded-2xl border border-rose-400/50 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </p>
        ) : null}

        <section className="grid items-end gap-12 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <p className="text-[11px] uppercase tracking-[0.32em] text-cyan-300">
              One place for the team’s code
            </p>
            <h1 className="font-display mt-5 max-w-3xl text-6xl leading-[0.92] text-slate-50 sm:text-7xl">
              Work in the same repository, at the same time.
            </h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-slate-300">
              Together is a browser workspace for small teams. Sign in with GitHub, open a real
              repository, and edit it together — with live cursors, chat, and git — without cloning
              anything onto your own laptop.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <a
                className="inline-flex items-center gap-3 rounded-full bg-cyan-300 px-5 py-3 text-sm font-semibold text-slate-950 hover:bg-cyan-200"
                href={signInPath}
              >
                <GitHubMark />
                Continue with GitHub
              </a>
              <a className="text-sm text-slate-300 hover:text-slate-50" href="#how-it-works">
                See how a session starts
              </a>
            </div>
            <p className="mt-4 max-w-lg text-xs leading-5 text-slate-500">
              GitHub is asked for your profile, email, and repository access so Together can list
              repos, clone one, and push as the workspace owner.
            </p>
          </div>

          <aside className="glass rounded-3xl p-6">
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
              Inside a session
            </p>
            <div className="mt-5 space-y-4 font-mono text-sm leading-6">
              <p>
                <span className="text-cyan-300">you</span>
                <span className="text-slate-500"> · src/App.tsx</span>
              </p>
              <p className="rounded-2xl bg-slate-950/70 px-4 py-3 text-slate-200">
                Two people, one file. Cursors stay visible while the merged text is written back to
                the repository on disk.
              </p>
              <p>
                <span className="text-amber-200">teammate</span>
                <span className="text-slate-500"> · online</span>
              </p>
              <p className="text-slate-400">
                Commit all changes, pull before newer remote commits, then push from the owner’s
                GitHub account.
              </p>
            </div>
          </aside>
        </section>

        <section className="mt-20" id="how-it-works">
          <h2 className="font-display text-4xl text-slate-50">From sign-in to a shared repo</h2>
          <ol className="mt-8 grid gap-4 md:grid-cols-2">
            {steps.map((step) => (
              <li key={step.index} className="glass rounded-3xl p-6">
                <p className="text-[11px] tracking-[0.24em] text-cyan-300">{step.index}</p>
                <h3 className="mt-3 text-lg text-slate-50">{step.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-300">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-16 grid items-start gap-8 lg:grid-cols-[1.1fr_0.9fr]" id="brain">
          <div>
            <p className="text-[11px] uppercase tracking-[0.32em] text-cyan-300">Workspace brain</p>
            <h2 className="font-display mt-4 text-5xl text-slate-50">
              Ask the repo you already share.
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-7 text-slate-300">
              Open a workspace and ask about its people, files, commits, or chat. Together keeps
              those links in a FalkorDB graph and answers from the graph, with the file, person, or
              message each line came from.
            </p>
          </div>
          <div className="rounded-3xl border border-slate-700 bg-slate-950/80 p-6">
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400">Key focus</p>
            <ul className="mt-4 space-y-3 text-sm text-slate-200">
              <li className="rounded-2xl border border-slate-700 px-4 py-3">
                People, files, commits, and chat in one FalkorDB graph
              </li>
              <li className="rounded-2xl border border-slate-700 px-4 py-3">
                Who owns the workspace, and who joined it
              </li>
              <li className="rounded-2xl border border-slate-700 px-4 py-3">
                Every answer points at its source
              </li>
              <li className="rounded-2xl border border-slate-700 px-4 py-3">
                A file source opens in the editor
              </li>
            </ul>
          </div>
        </section>

        <section className="mt-16">
          <h2 className="font-display text-4xl text-slate-50">What you can do today</h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {capabilities.map((item) => (
              <article
                key={item.title}
                className="rounded-3xl border border-slate-800 bg-slate-900/80 p-6"
              >
                <h3 className="text-lg text-slate-50">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-300">{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="glass mt-16 flex flex-col items-start justify-between gap-6 rounded-3xl px-6 py-8 sm:flex-row sm:items-center">
          <div>
            <h2 className="font-display text-4xl text-slate-50">Open your GitHub account</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">
              After GitHub sends you back, your dashboard lists the workspaces you own and the ones
              you have joined.
            </p>
          </div>
          <a
            className="inline-flex shrink-0 items-center gap-3 rounded-full bg-cyan-300 px-5 py-3 text-sm font-semibold text-slate-950 hover:bg-cyan-200"
            href={signInPath}
          >
            <GitHubMark />
            Sign in with GitHub
          </a>
        </section>
      </main>
    </div>
  );
}

function GitHubMark() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.7 7.7 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
