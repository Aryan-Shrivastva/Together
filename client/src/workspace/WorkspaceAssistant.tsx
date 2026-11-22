import { useCallback, useEffect, useState } from 'react';

type AssistantMessage = {
  id: string;
  question: string;
  answer: string;
  createdAt: string;
  user: { username: string };
};
type AgentTask = {
  id: string;
  username: string;
  prompt: string;
  status: string;
  progress: string;
  branchWorkspaceId: string | null;
  branchName: string | null;
  result: string | null;
};

export function WorkspaceAssistant({
  workspaceId,
  isViewer,
}: {
  workspaceId: string;
  isViewer: boolean;
}) {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState('');
  const [edit, setEdit] = useState(false);
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  const [branchId, setBranchId] = useState('');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const endpoint = `/api/workspaces/${workspaceId}/assistant`;
  const tasksEndpoint = `/api/workspaces/${workspaceId}/agent-tasks`;
  const loadTasks = useCallback(async () => {
    const response = await fetch(tasksEndpoint, { credentials: 'include' });
    if (response.ok) setTasks(((await response.json()) as { tasks: AgentTask[] }).tasks);
  }, [tasksEndpoint]);
  useEffect(() => {
    void loadTasks();
    const timer = window.setInterval(() => void loadTasks(), 5000);
    return () => window.clearInterval(timer);
  }, [loadTasks]);
  async function launchTask() {
    if (!taskPrompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(tasksEndpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: taskPrompt.trim() }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? 'Could not start the task.');
      }
      setTaskPrompt('');
      await loadTasks();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the task.');
    } finally {
      setBusy(false);
    }
  }
  const load = useCallback(async () => {
    const response = await fetch(endpoint, { credentials: 'include' });
    if (!response.ok) throw new Error('Unable to load assistant history.');
    const data = (await response.json()) as { messages: AssistantMessage[] };
    setMessages(data.messages);
  }, [endpoint]);
  useEffect(() => {
    void load().catch(() => setError('Unable to load assistant history.'));
  }, [load]);
  const loadBranches = useCallback(async () => {
    const response = await fetch(`/api/workspaces/${workspaceId}/branches`, {
      credentials: 'include',
    });
    if (response.ok) {
      const payload = (await response.json()) as { branches: Array<{ id: string; name: string }> };
      setBranches(payload.branches);
    }
  }, [workspaceId]);
  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);
  async function runTests() {
    if (!branchId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${endpoint}/test`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchId }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Tests could not run.');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Tests could not run.');
    } finally {
      setBusy(false);
    }
  }
  async function ask() {
    if (!question.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: question.trim(),
          ...(path.trim() ? { path: path.trim() } : {}),
          edit,
        }),
      });
      const payload = (await response.json()) as { message?: AssistantMessage; error?: string };
      if (!response.ok || !payload.message)
        throw new Error(payload.error ?? 'Unable to ask the assistant.');
      setQuestion('');
      await load();
      await loadBranches();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to ask the assistant.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col p-4 text-xs">
      <h3 className="text-sm font-semibold">Workspace assistant</h3>
      <p className="mt-1 text-[#a89984]">
        Ask about the project, chat, activity, or a selected file. Relevant repository excerpts and
        conversation context are sent to OpenAI.
      </p>
      <div className="mt-3 max-h-64 shrink-0 overflow-auto rounded border border-[#51483e] p-2">
        <p className="font-semibold">Shared agent tasks</p>
        <p className="mt-1 text-[#a89984]">
          Creates a branch and runs available checks. Teammates can see task details; review before
          merging. Relevant code is sent to OpenAI.
        </p>
        {!isViewer && (
          <>
            <textarea
              aria-label="Agent task"
              className="mt-2 h-16 w-full rounded border border-[#6b655c] bg-[#1c1b19] p-2"
              value={taskPrompt}
              onChange={(event) => setTaskPrompt(event.target.value)}
              maxLength={4000}
              placeholder="Describe the feature for the agent…"
            />
            <button
              type="button"
              className="rounded bg-cyan-500 px-3 py-1 text-slate-950 disabled:opacity-40"
              disabled={busy || !taskPrompt.trim()}
              onClick={() => void launchTask()}
            >
              Launch agent
            </button>
          </>
        )}
        {tasks.map((task) => (
          <div
            key={task.id}
            className="mt-2 whitespace-pre-wrap break-words border-t border-[#51483e] pt-2"
          >
            <strong>{task.username}</strong> · {task.status}
            <p>{task.prompt}</p>
            <p className="text-cyan-200">{task.progress}</p>
            {task.branchName && (
              <p>
                {task.branchName}{' '}
                {task.branchWorkspaceId && (
                  <a className="underline" href={`/workspaces/${task.branchWorkspaceId}`}>
                    Open branch
                  </a>
                )}
              </p>
            )}
            {task.result && <p className="mt-1">{task.result}</p>}
          </div>
        ))}
      </div>
      <div
        role="log"
        className="mt-3 min-h-0 flex-1 space-y-3 overflow-auto rounded-xl border border-[#45413a] bg-[#1b1b19] p-3"
      >
        {!messages.length ? (
          <p className="text-[#a89984]">Try “Summarize what happened while I was away.”</p>
        ) : null}
        {messages.map((message) => (
          <div key={message.id} className="space-y-2 whitespace-pre-wrap break-words">
            <p>
              <strong>{message.user.username}</strong>: {message.question}
            </p>
            <p className="rounded-lg bg-[#292824] p-3">
              <strong className="text-cyan-200">Assistant</strong>
              <br />
              {message.answer}
            </p>
          </div>
        ))}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-amber-200">
          {error}
        </p>
      ) : null}
      <input
        aria-label="Workspace file path"
        className="mt-3 rounded border border-[#6b655c] bg-[#1c1b19] p-2"
        value={path}
        onChange={(event) => setPath(event.target.value)}
        placeholder="Optional file path, e.g. src/App.tsx"
        disabled={isViewer || busy}
      />
      <label className="mt-2 flex items-center gap-2 text-[#d4bd99]">
        <input
          type="checkbox"
          checked={edit}
          onChange={(event) => setEdit(event.target.checked)}
          disabled={isViewer || busy}
        />{' '}
        Create a task branch with an edit to this file
      </label>
      <div className="mt-3 flex gap-2">
        <select
          aria-label="Task branch to test"
          className="min-w-0 flex-1 rounded border border-[#6b655c] bg-[#1c1b19] p-2"
          value={branchId}
          onChange={(event) => setBranchId(event.target.value)}
          disabled={isViewer || busy}
        >
          <option value="">Choose task branch</option>
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="rounded border border-cyan-400 px-2 text-cyan-100 disabled:opacity-40"
          disabled={isViewer || busy || !branchId}
          onClick={() => void runTests()}
        >
          Run npm test
        </button>
      </div>
      <textarea
        aria-label="Ask workspace assistant"
        className="mt-3 h-20 resize-none rounded border border-[#6b655c] bg-[#1c1b19] p-2"
        value={question}
        maxLength={4000}
        disabled={isViewer || busy}
        onChange={(event) => setQuestion(event.target.value)}
        placeholder="Ask about your workspace…"
      />
      <button
        type="button"
        className="mt-2 self-end rounded bg-cyan-500 px-3 py-2 font-semibold text-slate-950 disabled:opacity-40"
        disabled={isViewer || busy || !question.trim() || (edit && !path.trim())}
        onClick={() => void ask()}
      >
        {busy ? 'Thinking…' : 'Ask assistant'}
      </button>
    </div>
  );
}
