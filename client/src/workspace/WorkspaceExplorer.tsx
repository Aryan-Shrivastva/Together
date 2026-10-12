import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { io } from 'socket.io-client';
import { MonacoBinding } from 'y-monaco';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

import { useAuth } from '../auth/AuthContext';

loader.config({ monaco });

type Workspace = {
  id: string;
  name: string;
  repoFullName: string;
  defaultBranch: string;
  status: 'CLONING' | 'READY' | 'ERROR';
};

type FileTreeNode = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  children?: FileTreeNode[];
};

type ContextMenuState = {
  node: FileTreeNode;
  x: number;
  y: number;
};

type OpenFile = {
  path: string;
  content: string;
  language: string;
};
type PresenceUser = { id: string; username: string; avatarUrl: string; filePath: string | null };
type ChatMessage = { id: string; content: string; createdAt: string; user: { id: string; username: string; avatarUrl: string } };

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
    'name' in value &&
    typeof value.name === 'string' &&
    'repoFullName' in value &&
    typeof value.repoFullName === 'string' &&
    'defaultBranch' in value &&
    typeof value.defaultBranch === 'string' &&
    'status' in value &&
    (value.status === 'CLONING' || value.status === 'READY' || value.status === 'ERROR')
  );
}

function isFileTreeNode(value: unknown): value is FileTreeNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'path' in value &&
    typeof value.path === 'string' &&
    'kind' in value &&
    (value.kind === 'directory' || value.kind === 'file')
  );
}

function isFilePayload(value: unknown): value is { path: string; content: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    typeof value.path === 'string' &&
    'content' in value &&
    typeof value.content === 'string'
  );
}

function languageForPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  const languages: Record<string, string> = {
    c: 'c',
    cpp: 'cpp',
    css: 'css',
    go: 'go',
    html: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    md: 'markdown',
    mjs: 'javascript',
    py: 'python',
    rs: 'rust',
    sh: 'shell',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'typescript',
    yml: 'yaml',
    yaml: 'yaml',
  };

  return (extension && languages[extension]) || 'plaintext';
}

function collaborationUrl(workspaceId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/yjs/${workspaceId}`;
}

function colorForUser(userId: string): string {
  let hash = 0;
  for (const character of userId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return `hsl(${hash % 360} 80% 65%)`;
}

function parentPath(node: FileTreeNode | null): string {
  if (!node) {
    return '';
  }

  if (node.kind === 'directory') {
    return node.path;
  }

  const segments = node.path.split('/');
  segments.pop();
  return segments.join('/');
}

function childPath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function TreeNodeRow({
  node,
  depth,
  expanded,
  selectedFile,
  onToggle,
  onSelectFile,
  onOpenMenu,
}: {
  node: FileTreeNode;
  depth: number;
  expanded: Set<string>;
  selectedFile: string | null;
  onToggle: (path: string) => void;
  onSelectFile: (path: string) => void;
  onOpenMenu: (event: React.MouseEvent, node: FileTreeNode) => void;
}) {
  const isDirectory = node.kind === 'directory';
  const isExpanded = expanded.has(node.path);

  return (
    <li>
      <div
        className={`flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-800 ${
          selectedFile === node.path ? 'bg-slate-800 text-cyan-200' : 'text-slate-200'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onContextMenu={(event) => onOpenMenu(event, node)}
      >
        {isDirectory ? (
          <button
            className="w-5 text-slate-400 hover:text-white"
            type="button"
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${node.name}`}
            onClick={() => onToggle(node.path)}
          >
            {isExpanded ? '⌄' : '›'}
          </button>
        ) : (
          <span className="w-5 text-center text-slate-500">•</span>
        )}
        <button
          className="min-w-0 flex-1 truncate text-left"
          type="button"
          onClick={() => (isDirectory ? onToggle(node.path) : onSelectFile(node.path))}
        >
          {node.name}
        </button>
      </div>
      {isDirectory && isExpanded && node.children ? (
        <ul>
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selectedFile={selectedFile}
              onToggle={onToggle}
              onSelectFile={onSelectFile}
              onOpenMenu={onOpenMenu}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function WorkspaceExplorer({ workspaceId }: { workspaceId: string }) {
  const { user } = useAuth();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveUpdateError, setLiveUpdateError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editorInstance, setEditorInstance] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [collaborationStatus, setCollaborationStatus] = useState('Connect to a file to collaborate.');
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const presenceSocketRef = useRef<ReturnType<typeof io> | null>(null);

  const loadTree = useCallback(async () => {
    const payload = await requestJson(`/api/workspaces/${workspaceId}/tree`);
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('tree' in payload) ||
      !Array.isArray(payload.tree)
    ) {
      throw new Error('The workspace tree response was invalid.');
    }

    setTree(payload.tree.filter(isFileTreeNode));
  }, [workspaceId]);

  useEffect(() => {
    let isCurrent = true;

    async function loadWorkspace() {
      try {
        const workspacePayload = await requestJson(`/api/workspaces/${workspaceId}`);
        if (
          typeof workspacePayload !== 'object' ||
          workspacePayload === null ||
          !('workspace' in workspacePayload) ||
          !isWorkspace(workspacePayload.workspace)
        ) {
          throw new Error('The workspace response was invalid.');
        }

        if (!isCurrent) {
          return;
        }

        setWorkspace(workspacePayload.workspace);
        await loadTree();
        if (isCurrent) {
          setError(null);
        }
      } catch (requestError) {
        if (isCurrent) {
          setError(requestError instanceof Error ? requestError.message : 'Unable to load workspace files.');
        }
      } finally {
        if (isCurrent) {
          setIsLoading(false);
        }
      }
    }

    void loadWorkspace();

    return () => {
      isCurrent = false;
    };
  }, [loadTree, workspaceId]);

  useEffect(() => {
    if (workspace?.status !== 'READY') {
      return undefined;
    }

    const socket = io({
      auth: { workspaceId },
      withCredentials: true,
    });

    socket.on('fs:changed', () => {
      void loadTree().catch((requestError: unknown) => {
        setLiveUpdateError(
          requestError instanceof Error ? requestError.message : 'Unable to refresh workspace files.',
        );
      });
    });
    socket.on('connect', () => setLiveUpdateError(null));
    socket.on('connect_error', () => {
      setLiveUpdateError('Live file updates are temporarily unavailable.');
    });

    return () => {
      socket.disconnect();
    };
  }, [loadTree, workspace?.status, workspaceId]);

  useEffect(() => {
    if (!activeFilePath || activeFilePath !== editorPath || !editorInstance || !user) {
      return undefined;
    }

    const document = new Y.Doc();
    const provider = new WebsocketProvider(
      collaborationUrl(workspaceId),
      encodeURIComponent(activeFilePath),
      document,
    );
    const awareness = provider.awareness;
    awareness.setLocalStateField('user', {
      name: user.username,
      color: colorForUser(user.id),
    });
    setCollaborationStatus('Synchronizing with collaborators…');

    let binding: MonacoBinding | undefined;
    const synchronize = (isSynchronized: boolean) => {
      if (!isSynchronized || binding || !editorInstance.getModel()) {
        return;
      }

      binding = new MonacoBinding(
        document.getText('content'),
        editorInstance.getModel()!,
        new Set([editorInstance]),
        awareness,
      );
      setCollaborationStatus('Live collaboration connected.');
    };
    const connectionError = () => setCollaborationStatus('Collaboration connection failed.');

    provider.on('sync', synchronize);
    provider.on('connection-error', connectionError);

    return () => {
      binding?.destroy();
      awareness.setLocalState(null);
      provider.destroy();
      setCollaborationStatus('Connect to a file to collaborate.');
    };
  }, [activeFilePath, editorInstance, editorPath, user, workspaceId]);

  useEffect(() => {
    if (workspace?.status !== 'READY') return undefined;
    const socket = io({ auth: { workspaceId }, withCredentials: true });
    presenceSocketRef.current = socket;
    socket.on('presence:update', (payload: { users?: PresenceUser[] }) => setPresence(payload.users ?? []));
    socket.on('chat:message', (message: ChatMessage) => setMessages((current) => [...current, message]));
    void requestJson(`/api/workspaces/${workspaceId}/messages`).then((payload) => {
      if (typeof payload === 'object' && payload !== null && 'messages' in payload && Array.isArray(payload.messages)) setMessages(payload.messages as ChatMessage[]);
    });
    return () => { presenceSocketRef.current = null; socket.disconnect(); };
  }, [workspace?.status, workspaceId]);

  useEffect(() => {
    presenceSocketRef.current?.emit('presence:update', { filePath: activeFilePath });
  }, [activeFilePath]);

  function sendChat() {
    const content = chatInput.trim();
    if (!content) return;
    presenceSocketRef.current?.emit('chat:send', { content });
    setChatInput('');
  }

  const displayedTree = useMemo(() => tree, [tree]);
  const activeTab = tabs.find((tab) => tab.path === activeFilePath) ?? null;

  function toggleDirectory(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  async function openFile(path: string) {
    const existingTab = tabs.find((tab) => tab.path === path);
    if (existingTab) {
      setActiveFilePath(existingTab.path);
      return;
    }

    try {
      const payload = await requestJson(
        `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}`,
      );
      if (!isFilePayload(payload)) {
        throw new Error('The file response was invalid.');
      }

      const file = {
        path: payload.path,
        content: payload.content,
        language: languageForPath(payload.path),
      };
      setTabs((currentTabs) =>
        currentTabs.some((tab) => tab.path === file.path) ? currentTabs : [...currentTabs, file],
      );
      setActiveFilePath(file.path);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to open the file.');
    }
  }

  function closeTab(path: string) {
    setTabs((currentTabs) => {
      const closingIndex = currentTabs.findIndex((tab) => tab.path === path);
      const nextTabs = currentTabs.filter((tab) => tab.path !== path);

      if (path === activeFilePath) {
        setActiveFilePath(nextTabs[closingIndex]?.path ?? nextTabs[closingIndex - 1]?.path ?? null);
      }

      return nextTabs;
    });
  }

  async function createEntry(kind: 'file' | 'directory', node: FileTreeNode | null) {
    const label = kind === 'file' ? 'file name or path' : 'folder name or path';
    const name = window.prompt(`Enter the ${label}:`);
    if (!name) {
      return;
    }

    try {
      await requestJson(`/api/workspaces/${workspaceId}/file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: childPath(parentPath(node), name), kind }),
      });
      await loadTree();
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to create the item.');
    }
  }

  async function renameEntry(node: FileTreeNode) {
    const targetPath = window.prompt('Enter the new path:', node.path);
    if (!targetPath || targetPath === node.path) {
      return;
    }

    try {
      await requestJson(`/api/workspaces/${workspaceId}/file`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: node.path, targetPath }),
      });
      setTabs((currentTabs) =>
        currentTabs.map((tab) => {
          if (tab.path === node.path) {
            return { ...tab, path: targetPath, language: languageForPath(targetPath) };
          }

          if (node.kind === 'directory' && tab.path.startsWith(`${node.path}/`)) {
            const movedPath = `${targetPath}${tab.path.slice(node.path.length)}`;
            return { ...tab, path: movedPath, language: languageForPath(movedPath) };
          }

          return tab;
        }),
      );
      setActiveFilePath((currentPath) => {
        if (currentPath === node.path) {
          return targetPath;
        }

        if (node.kind === 'directory' && currentPath?.startsWith(`${node.path}/`)) {
          return `${targetPath}${currentPath.slice(node.path.length)}`;
        }

        return currentPath;
      });
      await loadTree();
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to rename the item.');
    }
  }

  async function deleteEntry(node: FileTreeNode) {
    if (!window.confirm(`Delete ${node.path}? This cannot be undone.`)) {
      return;
    }

    try {
      await requestJson(`/api/workspaces/${workspaceId}/file?path=${encodeURIComponent(node.path)}`, {
        method: 'DELETE',
      });
      setTabs((currentTabs) =>
        currentTabs.filter(
          (tab) => tab.path !== node.path && !tab.path.startsWith(`${node.path}/`),
        ),
      );
      setActiveFilePath((currentPath) =>
        currentPath === node.path || currentPath?.startsWith(`${node.path}/`) ? null : currentPath,
      );
      await loadTree();
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to delete the item.');
    }
  }

  function openContextMenu(event: React.MouseEvent, node: FileTreeNode) {
    event.preventDefault();
    setContextMenu({ node, x: event.clientX, y: event.clientY });
  }

  function returnToDashboard() {
    window.location.assign('/');
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100" onClick={() => setContextMenu(null)}>
      <section className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-6">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-400">Together</p>
            <h1 className="mt-2 text-3xl font-bold">{workspace?.name ?? 'Workspace files'}</h1>
            {workspace ? (
              <p className="mt-2 text-sm text-slate-400">
                {workspace.repoFullName} · {workspace.defaultBranch}
              </p>
            ) : null}
          </div>
          <button className="text-sm text-cyan-300 hover:text-cyan-200" type="button" onClick={returnToDashboard}>
            ← All workspaces
          </button>
        </header>

        {error ? <p className="mt-5 text-sm text-rose-300">{error}</p> : null}
        {liveUpdateError ? <p className="mt-3 text-sm text-amber-300">{liveUpdateError}</p> : null}
        {isLoading ? <p className="mt-10 text-slate-400">Loading workspace files…</p> : null}

        {!isLoading && workspace?.status !== 'READY' ? (
          <p className="mt-10 rounded-lg border border-slate-700 bg-slate-900 p-6 text-slate-300">
            This workspace is not ready yet. Return to the dashboard and wait for cloning to finish.
          </p>
        ) : null}

        {!isLoading && workspace?.status === 'READY' ? (
          <section className="mt-8 grid min-h-[34rem] gap-4 lg:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)_15rem]">
            <aside className="min-h-0 overflow-auto rounded-xl border border-slate-800 bg-slate-900 shadow-xl">
              <div className="border-b border-slate-800 p-4">
                <h2 className="font-semibold">Files</h2>
                <p className="mt-1 text-xs text-slate-400">Right-click an item to create, rename, or delete.</p>
                <div className="mt-3 flex gap-2">
                  <button
                    className="rounded-md border border-slate-700 px-3 py-2 text-xs hover:border-cyan-400 hover:text-cyan-200"
                    type="button"
                    onClick={() => void createEntry('directory', null)}
                  >
                    New folder
                  </button>
                  <button
                    className="rounded-md bg-cyan-400 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-300"
                    type="button"
                    onClick={() => void createEntry('file', null)}
                  >
                    New file
                  </button>
                </div>
              </div>
              <div className="p-3">
                {displayedTree.length === 0 ? (
                  <p className="p-3 text-sm text-slate-400">This repository has no files yet.</p>
                ) : (
                  <ul>
                    {displayedTree.map((node) => (
                      <TreeNodeRow
                        key={node.path}
                        node={node}
                        depth={0}
                        expanded={expanded}
                        selectedFile={activeFilePath}
                        onToggle={toggleDirectory}
                        onSelectFile={(path) => void openFile(path)}
                        onOpenMenu={openContextMenu}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </aside>

            <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-xl">
              <div className="flex min-h-12 overflow-x-auto border-b border-slate-800 bg-slate-950">
                {tabs.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-slate-400">Select a file to open it in the editor.</p>
                ) : (
                  tabs.map((tab) => (
                    <div
                      key={tab.path}
                      className={`flex shrink-0 items-center gap-2 border-r border-slate-800 px-3 text-sm ${
                        tab.path === activeFilePath
                          ? 'bg-slate-900 text-cyan-200'
                          : 'bg-slate-950 text-slate-400 hover:bg-slate-900'
                      }`}
                    >
                      <button className="max-w-44 truncate py-3" type="button" onClick={() => setActiveFilePath(tab.path)}>
                        {tab.path.split('/').pop()}
                      </button>
                      <button
                        className="text-slate-500 hover:text-rose-300"
                        type="button"
                        aria-label={`Close ${tab.path}`}
                        onClick={() => closeTab(tab.path)}
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="min-h-[30rem] flex-1">
                {activeTab ? (
                  <Editor
                    key={activeTab.path}
                    height="100%"
                    language={activeTab.language}
                    theme="vs-dark"
                    defaultValue={activeTab.content}
                    path={activeTab.path}
                    onMount={(editor) => {
                      setEditorInstance(editor);
                      setEditorPath(activeTab.path);
                    }}
                    options={{
                      automaticLayout: true,
                      fontSize: 14,
                      minimap: { enabled: false },
                      padding: { top: 16 },
                      readOnly: collaborationStatus !== 'Live collaboration connected.',
                      scrollBeyondLastLine: false,
                      wordWrap: 'on',
                    }}
                  />
                ) : (
                  <div className="grid h-full place-items-center p-8 text-center text-slate-400">
                    <div>
                      <p className="font-medium text-slate-200">No file open</p>
                      <p className="mt-2 text-sm">Choose a text file from the explorer to begin editing.</p>
                    </div>
                  </div>
                )}
              </div>
              {activeTab ? (
                <p className="border-t border-slate-800 px-4 py-2 text-xs text-amber-200">
                  {collaborationStatus} Changes are saved to the shared workspace shortly after typing.
                </p>
              ) : null}
            </section>

            <aside className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-xl">
              <h2 className="font-semibold">Workspace</h2>
              <p className="mt-3 text-sm text-slate-400">Branch: {workspace.defaultBranch}</p>
              <div className="mt-6 border-t border-slate-800 pt-5">
                <h3 className="text-sm font-semibold text-slate-200">Git</h3>
                <div className="mt-3 grid gap-2">
                  <button className="rounded-md border border-slate-700 px-3 py-2 text-left text-sm text-slate-500" type="button" disabled>
                    Pull
                  </button>
                  <button className="rounded-md border border-slate-700 px-3 py-2 text-left text-sm text-slate-500" type="button" disabled>
                    Commit
                  </button>
                  <button className="rounded-md border border-slate-700 px-3 py-2 text-left text-sm text-slate-500" type="button" disabled>
                    Push
                  </button>
                </div>
                <p className="mt-3 text-xs text-slate-500">Git actions arrive in Step 10.</p>
              </div>
              <div className="mt-6 border-t border-slate-800 pt-5">
                <h3 className="text-sm font-semibold text-slate-200">Online now ({presence.length})</h3>
                <div className="mt-3 space-y-2 text-xs text-slate-400">{presence.map((member) => <p key={member.id}>{member.username}{member.filePath ? ` · ${member.filePath}` : ''}</p>)}</div>
              </div>
              <div className="mt-6 border-t border-slate-800 pt-5">
                <h3 className="text-sm font-semibold text-slate-200">Team chat</h3>
                <div className="mt-3 max-h-56 space-y-3 overflow-auto text-xs">{messages.map((message) => <p key={message.id}><span className="font-semibold text-cyan-200">{message.user.username}</span><br />{message.content}</p>)}</div>
                <textarea className="mt-3 w-full rounded border border-slate-700 bg-slate-950 p-2 text-xs" value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="Message the team" />
                <button className="mt-2 rounded bg-cyan-400 px-3 py-2 text-xs font-semibold text-slate-950" type="button" onClick={sendChat}>Send</button>
              </div>
            </aside>
          </section>
        ) : null}
      </section>

      {contextMenu ? (
        <div
          className="fixed z-10 min-w-44 rounded-md border border-slate-700 bg-slate-900 p-1 shadow-2xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-slate-800"
            type="button"
            onClick={() => {
              void createEntry('file', contextMenu.node);
              setContextMenu(null);
            }}
          >
            New file here
          </button>
          <button
            className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-slate-800"
            type="button"
            onClick={() => {
              void createEntry('directory', contextMenu.node);
              setContextMenu(null);
            }}
          >
            New folder here
          </button>
          <button
            className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-slate-800"
            type="button"
            onClick={() => {
              void renameEntry(contextMenu.node);
              setContextMenu(null);
            }}
          >
            Rename or move
          </button>
          <button
            className="block w-full rounded px-3 py-2 text-left text-sm text-rose-300 hover:bg-slate-800"
            type="button"
            onClick={() => {
              void deleteEntry(contextMenu.node);
              setContextMenu(null);
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </main>
  );
}
