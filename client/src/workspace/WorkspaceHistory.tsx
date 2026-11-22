import { useEffect, useState } from 'react';

type Commit = { hash: string; date: string; message: string; author: string };
export function WorkspaceHistory({ workspaceId }: { workspaceId: string }) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selected, setSelected] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [diff, setDiff] = useState<{ path: string; text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState('');
  const root = `/api/workspaces/${workspaceId}/git/history`;
  async function get(path: string) {
    const response = await fetch(path, { credentials: 'include' });
    if (!response.ok) throw new Error('Could not load history. Please try again.');
    return response.json();
  }
  useEffect(() => {
    let active = true;
    fetch(root, { credentials: 'include' })
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<{ commits: Commit[] }>;
      })
      .then((data) => {
        if (active) setCommits(data.commits);
      })
      .catch(() => {
        if (active) setError('Could not load history.');
      });
    return () => {
      active = false;
    };
  }, [root]);
  async function selectCommit(hash: string) {
    setSelected(hash);
    setFiles([]);
    setDiff(null);
    setError('');
    try {
      setFiles(((await get(`${root}/${hash}`)) as { files: string[] }).files);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  async function selectFile(path: string) {
    setError('');
    setDiff(null);
    try {
      const result = (await get(`${root}/${selected}/diff?path=${encodeURIComponent(path)}`)) as {
        diff: string;
        truncated: boolean;
      };
      setDiff({ path, text: result.diff, truncated: result.truncated });
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  return (
    <details className="border-b border-[#51483e] px-5 py-3 text-xs">
      <summary className="cursor-pointer font-semibold text-[#fbf1c7]">
        Recent committed changes
      </summary>
      <p className="mt-2 text-[#a89984]">
        Review committed work on this branch. No dependency installation is needed.
      </p>
      <div className="mt-2 max-h-72 space-y-2 overflow-auto">
        {!commits.length && !error && <p>No commits available.</p>}
        {commits.map((commit) => (
          <div key={commit.hash} className="rounded border border-[#51483e] p-2">
            <button
              type="button"
              className="text-left text-cyan-200"
              onClick={() => void selectCommit(commit.hash)}
            >
              {commit.message}
            </button>
            <p className="mt-1 text-[#a89984]">
              {commit.author} · {new Date(commit.date).toLocaleString()}
            </p>
            {selected === commit.hash && (
              <div className="mt-2 space-y-1">
                {files.map((file) => (
                  <button
                    key={file}
                    type="button"
                    className="block break-all text-left underline"
                    onClick={() => void selectFile(file)}
                  >
                    {file}
                  </button>
                ))}
                {diff && (
                  <div className="mt-2">
                    <p className="text-cyan-200">
                      {diff.path}
                      {diff.truncated ? ' (truncated)' : ''}
                    </p>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-[#171715] p-2">
                      {diff.text || 'No text diff available.'}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-amber-200">
          {error}
        </p>
      )}
    </details>
  );
}
