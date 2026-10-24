import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { io } from 'socket.io-client';
import { MonacoBinding } from 'y-monaco';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

import { WorkspaceBrain } from './WorkspaceBrain';

loader.config({ monaco });

monaco.editor.defineTheme('mechanoonna', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: 'b08b6a', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'f5b942' },
    { token: 'string', foreground: 'ffd56a' },
    { token: 'number', foreground: 'ffb067' },
  ],
  colors: {
    'editor.background': '#3a3128',
    'editor.foreground': '#fff4df',
    'editorCursor.foreground': '#ffd56a',
    'editor.selectionBackground': '#8d7460',
    'editor.lineHighlightBackground': '#4e4338',
    'editorLineNumber.foreground': '#b08b6a',
    'editorLineNumber.activeForeground': '#ffd56a',
    'editorWidget.background': '#342b22',
    'minimap.background': '#342b22',
  },
});

type Workspace = {
  id: string;
  name: string;
  repoFullName: string;
  defaultBranch: string;
  status: 'CLONING' | 'READY' | 'ERROR';
  role: 'OWNER' | 'COLLABORATOR';
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
type ChatMessage = {
  id: string;
  content: string;
  createdAt: string;
  user: { id: string; username: string; avatarUrl: string };
};
type GitFileStatus = { path: string; index: string; workingDirectory: string };
type GitStatus = {
  current: string | null;
  tracking: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
};
type GitStatusResponse = Omit<GitStatus, 'files'> & {
  files: Array<{ path: string; index: string; working_dir: string }>;
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
    'name' in value &&
    typeof value.name === 'string' &&
    'repoFullName' in value &&
    typeof value.repoFullName === 'string' &&
    'defaultBranch' in value &&
    typeof value.defaultBranch === 'string' &&
    'status' in value &&
    (value.status === 'CLONING' || value.status === 'READY' || value.status === 'ERROR') &&
    'role' in value &&
    (value.role === 'OWNER' || value.role === 'COLLABORATOR')
  );
}

function isGitStatus(value: unknown): value is GitStatusResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'current' in value &&
    (typeof value.current === 'string' || value.current === null) &&
    'tracking' in value &&
    (typeof value.tracking === 'string' || value.tracking === null) &&
    'ahead' in value &&
    typeof value.ahead === 'number' &&
    'behind' in value &&
    typeof value.behind === 'number' &&
    'files' in value &&
    Array.isArray(value.files) &&
    value.files.every(
      (file) =>
        typeof file === 'object' &&
        file !== null &&
        'path' in file &&
        typeof file.path === 'string' &&
        'index' in file &&
        typeof file.index === 'string' &&
        'working_dir' in file &&
        typeof file.working_dir === 'string',
    )
  );
}

function toGitFileStatus(file: {
  path: string;
  index: string;
  working_dir: string;
}): GitFileStatus {
  return { path: file.path, index: file.index, workingDirectory: file.working_dir };
}

function gitFileBadge(file: GitFileStatus): string {
  if (file.index === '?' || file.workingDirectory === '?') return 'U';
  if (file.index === 'D' || file.workingDirectory === 'D') return 'D';
  if (file.index === 'A' || file.workingDirectory === 'A') return 'A';
  if (file.index === 'R' || file.workingDirectory === 'R') return 'R';
  return 'M';
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
  const [editorInstance, setEditorInstance] = useState<monaco.editor.IStandaloneCodeEditor | null>(
    null,
  );
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [collaborationStatus, setCollaborationStatus] = useState(
    'Connect to a file to collaborate.',
  );
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [isChatConnected, setIsChatConnected] = useState(false);
  const [isExplorerOpen, setIsExplorerOpen] = useState(true);
  const [isGitPanelOpen, setIsGitPanelOpen] = useState(false);
  const [isBottomPanelOpen, setIsBottomPanelOpen] = useState(true);
  const [isCollaborationPanelOpen, setIsCollaborationPanelOpen] = useState(false);
  const [isBrainOpen, setIsBrainOpen] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitAction, setGitAction] = useState<'commit' | 'pull' | 'push' | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const [gitNotice, setGitNotice] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
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

  const loadGitStatus = useCallback(async () => {
    try {
      const payload = await requestJson(`/api/workspaces/${workspaceId}/git/status`);
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('status' in payload) ||
        !isGitStatus(payload.status)
      ) {
        throw new Error('The Git status response was invalid.');
      }

      setGitStatus({
        ...payload.status,
        files: payload.status.files.map(toGitFileStatus),
      });
      setGitError(null);
    } catch (requestError) {
      setGitError(
        requestError instanceof Error ? requestError.message : 'Unable to load Git status.',
      );
    }
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
          setError(
            requestError instanceof Error
              ? requestError.message
              : 'Unable to load workspace files.',
          );
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
          requestError instanceof Error
            ? requestError.message
            : 'Unable to refresh workspace files.',
        );
      });
    });
    socket.on('connect', () => setLiveUpdateError(null));
    socket.on('disconnect', () => {
      setLiveUpdateError('Reconnecting to live file updates…');
    });
    socket.on('connect_error', () => {
      setLiveUpdateError('Reconnecting to live file updates…');
    });

    return () => {
      socket.disconnect();
    };
  }, [loadTree, workspace?.status, workspaceId]);

  useEffect(() => {
    if (workspace?.status === 'READY' && isGitPanelOpen) {
      void loadGitStatus();
    }
  }, [isGitPanelOpen, loadGitStatus, workspace?.status]);

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
    const connectionStatus = (event: { status: 'connected' | 'disconnected' }) => {
      if (event.status === 'disconnected') {
        setCollaborationStatus('Reconnecting collaboration…');
      } else if (binding) {
        setCollaborationStatus('Live collaboration connected.');
      }
    };

    provider.on('sync', synchronize);
    provider.on('connection-error', connectionError);
    provider.on('status', connectionStatus);

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
    socket.on('connect', () => {
      setIsChatConnected(true);
      setChatError(null);
    });
    socket.on('disconnect', () => {
      setIsChatConnected(false);
      setChatError('Reconnecting team chat…');
    });
    socket.on('connect_error', () => {
      setIsChatConnected(false);
      setChatError('Reconnecting team chat…');
    });
    socket.on('presence:update', (payload: { users?: PresenceUser[] }) =>
      setPresence(payload.users ?? []),
    );
    socket.on('chat:message', (message: ChatMessage) =>
      setMessages((current) => [...current, message]),
    );
    socket.on('chat:error', (payload: unknown) => {
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'error' in payload &&
        typeof payload.error === 'string'
      ) {
        setChatError(payload.error);
      }
    });
    socket.on('collaboration:error', (payload: unknown) => {
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'error' in payload &&
        typeof payload.error === 'string'
      ) {
        setCollaborationStatus(payload.error);
      }
    });
    void requestJson(`/api/workspaces/${workspaceId}/messages`)
      .then((payload) => {
        if (
          typeof payload === 'object' &&
          payload !== null &&
          'messages' in payload &&
          Array.isArray(payload.messages)
        ) {
          setMessages(payload.messages as ChatMessage[]);
        }
      })
      .catch((requestError: unknown) => {
        setChatError(
          requestError instanceof Error ? requestError.message : 'Unable to load chat history.',
        );
      });
    return () => {
      presenceSocketRef.current = null;
      setIsChatConnected(false);
      socket.disconnect();
    };
  }, [workspace?.status, workspaceId]);

  useEffect(() => {
    presenceSocketRef.current?.emit('presence:update', { filePath: activeFilePath });
  }, [activeFilePath]);

  function sendChat() {
    const content = chatInput.trim();
    if (!content || !isChatConnected) {
      if (!isChatConnected) {
        setChatError('Team chat is reconnecting. Please wait a moment.');
      }
      return;
    }
    presenceSocketRef.current?.emit('chat:send', { content });
    setChatInput('');
  }

  async function performGitAction(action: 'commit' | 'pull' | 'push') {
    if (action === 'commit' && !commitMessage.trim()) {
      setGitError('Enter a commit message first.');
      return;
    }

    setGitAction(action);
    setGitError(null);
    setGitNotice(null);

    try {
      if (action === 'commit') {
        await requestJson(`/api/workspaces/${workspaceId}/git/commit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: commitMessage.trim() }),
        });
        setCommitMessage('');
        setGitNotice('Commit created in the shared workspace.');
      } else {
        await requestJson(`/api/workspaces/${workspaceId}/git/${action}`, { method: 'POST' });
        setGitNotice(
          action === 'pull'
            ? 'Pulled the latest changes from GitHub.'
            : 'Pushed the current branch to GitHub.',
        );
      }

      await Promise.all([loadGitStatus(), loadTree()]);
    } catch (requestError) {
      setGitError(requestError instanceof Error ? requestError.message : `Git ${action} failed.`);
    } finally {
      setGitAction(null);
    }
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
      await requestJson(
        `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent(node.path)}`,
        {
          method: 'DELETE',
        },
      );
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
    <main
      className="h-screen overflow-hidden bg-[#342b22] text-slate-100"
      onClick={() => setContextMenu(null)}
    >
      <section className="flex h-full min-w-0 flex-col">
        <header className="flex h-9 shrink-0 items-center border-b border-[#2a231c] bg-[#4e4338] px-3 text-xs text-[#fff4df]">
          <div className="flex min-w-0 items-center gap-4">
            <span
              className="grid h-5 w-5 place-items-center text-base text-cyan-300"
              aria-label="Together"
            >
              ◇
            </span>
            <nav className="hidden items-center gap-4 md:flex" aria-label="Application menu">
              <span>File</span>
              <span>Edit</span>
              <span>Selection</span>
              <span>View</span>
              <span>Go</span>
              <span>Run</span>
              <span>Terminal</span>
              <span>Help</span>
            </nav>
          </div>
          <p className="mx-auto max-w-[45%] truncate rounded border border-[#7a6856] bg-[#3a3128] px-3 py-1 text-center text-[#f5b942]">
            {workspace?.name ?? 'Together'}
          </p>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              className={`grid h-7 w-7 place-items-center rounded text-base hover:bg-[#7a6856] hover:text-white ${isExplorerOpen ? 'text-cyan-200' : 'text-[#e2c7a4]'}`}
              title="Toggle Explorer"
              type="button"
              aria-label="Toggle Explorer"
              onClick={() => setIsExplorerOpen((open) => !open)}
            >
              ▯
            </button>
            <button
              className={`grid h-7 w-7 place-items-center rounded text-base hover:bg-[#7a6856] hover:text-white ${isBottomPanelOpen ? 'text-cyan-200' : 'text-[#e2c7a4]'}`}
              title="Toggle bottom panel"
              type="button"
              aria-label="Toggle bottom panel"
              onClick={() => setIsBottomPanelOpen((open) => !open)}
            >
              ▰
            </button>
            <button
              className={`grid h-7 w-7 place-items-center rounded text-base hover:bg-[#7a6856] hover:text-white ${isCollaborationPanelOpen ? 'bg-[#7a6856] text-cyan-200' : 'text-[#e2c7a4]'}`}
              title="Open team chat"
              type="button"
              aria-label="Open team chat"
              onClick={() => {
                setIsCollaborationPanelOpen((open) => !open);
                setIsBrainOpen(false);
              }}
            >
              ▯
            </button>
            <button
              className={`grid h-7 w-7 place-items-center rounded text-base hover:bg-[#7a6856] hover:text-white ${isBrainOpen ? 'bg-[#7a6856] text-cyan-200' : 'text-[#e2c7a4]'}`}
              title="Open workspace brain"
              type="button"
              aria-label="Open workspace brain"
              onClick={() => {
                setIsBrainOpen((open) => !open);
                setIsCollaborationPanelOpen(false);
              }}
            >
              ◉
            </button>
            <button
              className="ml-2 text-cyan-300 hover:text-cyan-100"
              type="button"
              onClick={returnToDashboard}
            >
              Workspaces
            </button>
          </div>
        </header>

        {error ? (
          <p className="absolute left-1/2 top-12 z-20 -translate-x-1/2 rounded border border-rose-500/50 bg-[#5c332c] px-4 py-2 text-sm text-rose-200 shadow-xl">
            {error}
          </p>
        ) : null}
        {liveUpdateError ? (
          <p className="absolute left-1/2 top-12 z-20 -translate-x-1/2 rounded border border-amber-500/50 bg-[#5c4630] px-4 py-2 text-sm text-amber-200 shadow-xl">
            {liveUpdateError}
          </p>
        ) : null}
        {collaborationStatus === 'Reconnecting collaboration…' ? (
          <p className="absolute left-1/2 top-24 z-20 -translate-x-1/2 rounded border border-amber-500/50 bg-[#5c4630] px-4 py-2 text-sm text-amber-200 shadow-xl">
            Reconnecting collaboration. Editing is temporarily paused.
          </p>
        ) : null}
        {isLoading ? (
          <p className="m-auto text-sm text-slate-400">Loading workspace files…</p>
        ) : null}

        {!isLoading && workspace?.status !== 'READY' ? (
          <p className="mt-10 rounded-lg border border-slate-700 bg-slate-900 p-6 text-slate-300">
            This workspace is not ready yet. Return to the dashboard and wait for cloning to finish.
          </p>
        ) : null}

        {!isLoading && workspace?.status === 'READY' ? (
          <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#3a3128]">
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <nav
                className="flex w-12 shrink-0 flex-col items-center border-r border-[#7a6856] bg-[#3a3128] py-2 text-xl text-[#fff4df]"
                aria-label="Activity bar"
              >
                <button
                  className={`grid h-12 w-full place-items-center ${!isGitPanelOpen ? 'border-l-2 border-cyan-300 bg-[#5c4e40] text-cyan-200' : 'text-[#e2c7a4] hover:bg-[#5c4e40] hover:text-white'}`}
                  title="Explorer"
                  type="button"
                  onClick={() => {
                    setIsExplorerOpen(true);
                    setIsGitPanelOpen(false);
                  }}
                >
                  ▱
                </button>
                <button
                  className="grid h-12 w-full place-items-center text-[#e2c7a4] hover:bg-[#5c4e40] hover:text-white"
                  title="Search"
                  type="button"
                >
                  ⌕
                </button>
                <button
                  className={`grid h-12 w-full place-items-center ${isGitPanelOpen ? 'border-l-2 border-cyan-300 bg-[#5c4e40] text-cyan-200' : 'text-[#e2c7a4] hover:bg-[#5c4e40] hover:text-white'}`}
                  title="Source control"
                  type="button"
                  onClick={() => {
                    setIsExplorerOpen(true);
                    setIsGitPanelOpen(true);
                    void loadGitStatus();
                  }}
                >
                  ⑂
                </button>
                <button
                  className="grid h-12 w-full place-items-center text-[#e2c7a4] hover:bg-[#5c4e40] hover:text-white"
                  title="Run and debug"
                  type="button"
                >
                  ▷
                </button>
                <button
                  className="grid h-12 w-full place-items-center text-[#e2c7a4] hover:bg-[#5c4e40] hover:text-white"
                  title="Extensions"
                  type="button"
                >
                  ▦
                </button>
                <button
                  className="mt-auto grid h-12 w-full place-items-center text-[#e2c7a4] hover:bg-[#5c4e40] hover:text-white"
                  title="Team collaboration"
                  type="button"
                  onClick={() => setIsCollaborationPanelOpen((open) => !open)}
                >
                  ◉
                </button>
              </nav>

              {isExplorerOpen && isGitPanelOpen ? (
                <aside className="flex w-72 shrink-0 flex-col border-r border-[#7a6856] bg-[#4e4338] text-[#fff4df]">
                  <div className="flex h-9 shrink-0 items-center justify-between px-5 text-[11px] font-semibold uppercase tracking-wide">
                    <h2>Source Control</h2>
                    <button
                      className="text-lg leading-none text-[#f5b942] hover:text-white"
                      type="button"
                      title="Refresh Git status"
                      aria-label="Refresh Git status"
                      onClick={() => void loadGitStatus()}
                    >
                      ↻
                    </button>
                  </div>
                  <div className="border-b border-[#7a6856] px-4 py-3 text-xs text-[#f5b942]">
                    <p className="truncate font-medium text-[#fff6e4]">{workspace.repoFullName}</p>
                    <p className="mt-1">
                      {gitStatus?.current ?? workspace.defaultBranch}
                      {gitStatus?.ahead ? ` · ↑${gitStatus.ahead}` : ''}
                      {gitStatus?.behind ? ` · ↓${gitStatus.behind}` : ''}
                    </p>
                  </div>
                  <div className="border-b border-[#7a6856] p-3">
                    <label className="sr-only" htmlFor="commit-message">
                      Commit message
                    </label>
                    <textarea
                      id="commit-message"
                      className="h-20 w-full resize-none rounded border border-[#9a846e] bg-[#3a3128] p-2 text-xs outline-none placeholder:text-[#8e8373] focus:border-cyan-400"
                      value={commitMessage}
                      maxLength={500}
                      onChange={(event) => setCommitMessage(event.target.value)}
                      placeholder="Message (required)"
                    />
                    <button
                      className="mt-2 w-full rounded bg-cyan-500 px-3 py-2 text-xs font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-[#7a6856] disabled:text-[#9a846e]"
                      type="button"
                      disabled={gitAction !== null || !commitMessage.trim()}
                      onClick={() => void performGitAction('commit')}
                    >
                      {gitAction === 'commit' ? 'Committing…' : 'Commit all changes'}
                    </button>
                  </div>
                  <div className="flex shrink-0 gap-2 border-b border-[#7a6856] p-3">
                    <button
                      className="flex-1 rounded border border-[#9a846e] px-2 py-2 text-xs hover:border-cyan-400 disabled:cursor-not-allowed disabled:text-[#8e8373]"
                      type="button"
                      disabled={gitAction !== null}
                      onClick={() => void performGitAction('pull')}
                    >
                      {gitAction === 'pull' ? 'Pulling…' : 'Pull'}
                    </button>
                    <button
                      className="flex-1 rounded border border-[#9a846e] px-2 py-2 text-xs hover:border-cyan-400 disabled:cursor-not-allowed disabled:text-[#8e8373]"
                      type="button"
                      title={
                        workspace.role === 'OWNER'
                          ? 'Push to GitHub'
                          : 'Only the workspace owner can push'
                      }
                      disabled={gitAction !== null || workspace.role !== 'OWNER'}
                      onClick={() => void performGitAction('push')}
                    >
                      {gitAction === 'push' ? 'Pushing…' : 'Push'}
                    </button>
                  </div>
                  {gitError ? (
                    <p className="mx-3 mt-3 rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200">
                      {gitError}
                    </p>
                  ) : null}
                  {gitNotice ? (
                    <p className="mx-3 mt-3 rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-200">
                      {gitNotice}
                    </p>
                  ) : null}
                  <div className="min-h-0 flex-1 overflow-auto">
                    <div className="flex items-center justify-between px-4 py-3 text-[11px] font-semibold uppercase tracking-wide">
                      <span>Changes</span>
                      <span>{gitStatus?.files.length ?? 0}</span>
                    </div>
                    {gitStatus?.files.length ? (
                      <ul className="px-2 pb-3">
                        {gitStatus.files.map((file) => (
                          <li
                            key={file.path}
                            className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-[#3a3128]"
                          >
                            <span className="w-4 text-center font-semibold text-amber-300">
                              {gitFileBadge(file)}
                            </span>
                            <span className="min-w-0 flex-1 truncate" title={file.path}>
                              {file.path}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="px-4 text-xs text-[#8e8373]">No changes to commit.</p>
                    )}
                  </div>
                  {workspace.role !== 'OWNER' ? (
                    <p className="border-t border-[#7a6856] p-3 text-xs text-[#8e8373]">
                      Only the workspace owner can push to GitHub.
                    </p>
                  ) : null}
                </aside>
              ) : isExplorerOpen ? (
                <aside className="flex w-72 shrink-0 flex-col border-r border-[#7a6856] bg-[#4e4338] text-[#fff4df]">
                  <div className="flex h-9 shrink-0 items-center justify-between px-5 text-[11px] font-semibold uppercase tracking-wide">
                    <h2>Explorer</h2>
                    <span className="text-lg leading-none text-[#f5b942]">···</span>
                  </div>
                  <div className="flex h-7 shrink-0 items-center gap-1 bg-[#3a3128] px-3 text-xs font-semibold">
                    <span className="text-cyan-200">⌄</span>
                    <span className="truncate">{workspace.name}</span>
                  </div>
                  <div className="flex shrink-0 gap-1 border-b border-[#7a6856] px-3 py-2">
                    <button
                      className="grid h-7 flex-1 place-items-center rounded border border-[#9a846e] text-xs hover:border-cyan-400 hover:text-cyan-200"
                      type="button"
                      onClick={() => void createEntry('directory', null)}
                    >
                      New folder
                    </button>
                    <button
                      className="grid h-7 flex-1 place-items-center rounded bg-cyan-500 text-xs font-semibold text-slate-950 hover:bg-cyan-300"
                      type="button"
                      onClick={() => void createEntry('file', null)}
                    >
                      New file
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto px-2 py-1">
                    {displayedTree.length === 0 ? (
                      <p className="p-3 text-sm text-slate-400">
                        This repository has no files yet.
                      </p>
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
                  <div className="shrink-0 border-t border-[#7a6856] text-xs text-[#f5b942]">
                    <p className="border-b border-[#7a6856] px-4 py-2">› Outline</p>
                    <p className="border-b border-[#7a6856] px-4 py-2">› Timeline</p>
                    <p className="px-4 py-2">› Git</p>
                  </div>
                </aside>
              ) : null}

              <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#3a3128]">
                <div className="flex h-9 shrink-0 overflow-x-auto border-b border-[#7a6856] bg-[#4e4338]">
                  {tabs.length === 0 ? (
                    <p className="px-4 py-2 text-xs text-[#f5b942]">
                      Select a file to open it in the editor.
                    </p>
                  ) : (
                    tabs.map((tab) => (
                      <div
                        key={tab.path}
                        className={`flex h-9 shrink-0 items-center gap-2 border-r border-[#7a6856] px-3 text-xs ${
                          tab.path === activeFilePath
                            ? 'border-t-2 border-t-cyan-400 bg-[#3a3128] text-[#fffaf2]'
                            : 'bg-[#342b22] text-[#f5b942] hover:bg-[#3a3128]'
                        }`}
                      >
                        <button
                          className="max-w-44 truncate"
                          type="button"
                          onClick={() => setActiveFilePath(tab.path)}
                        >
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
                <div className="min-h-0 flex-1">
                  {activeTab ? (
                    <Editor
                      key={activeTab.path}
                      height="100%"
                      language={activeTab.language}
                      theme="mechanoonna"
                      defaultValue={activeTab.content}
                      path={activeTab.path}
                      onMount={(editor) => {
                        setEditorInstance(editor);
                        setEditorPath(activeTab.path);
                      }}
                      options={{
                        automaticLayout: true,
                        fontSize: 14,
                        minimap: { enabled: true },
                        padding: { top: 12 },
                        // Avoid Chromium GPU/canvas artefacts in large collaborative files.
                        experimentalGpuAcceleration: 'off',
                        colorDecorators: false,
                        unicodeHighlight: {
                          ambiguousCharacters: false,
                          invisibleCharacters: false,
                          nonBasicASCII: false,
                        },
                        readOnly: collaborationStatus !== 'Live collaboration connected.',
                        scrollBeyondLastLine: false,
                        wordWrap: 'off',
                      }}
                    />
                  ) : (
                    <div className="grid h-full place-items-center p-8 text-center text-slate-400">
                      <div>
                        <p className="font-medium text-slate-200">No file open</p>
                        <p className="mt-2 text-sm">
                          Choose a text file from the explorer to begin editing.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
                {isBottomPanelOpen ? (
                  <section className="h-44 shrink-0 border-t border-[#7a6856] bg-[#342b22]">
                    <div className="flex h-9 items-center gap-5 border-b border-[#7a6856] px-4 text-[11px] font-semibold uppercase tracking-wider text-[#f5b942]">
                      <span>Problems</span>
                      <span>Output</span>
                      <span className="border-b-2 border-cyan-300 py-[10px] text-[#fff6e4]">
                        Terminal
                      </span>
                      <span>Ports</span>
                    </div>
                    <pre className="h-[8.75rem] overflow-auto p-4 font-mono text-xs leading-6 text-[#f5b942]">
                      together@{workspace.name}:~${' '}
                      <span className="text-emerald-300">
                        Workspace terminal will be enabled in Phase 2.
                      </span>
                      {'\n'}$ Shared run output and tests will appear here.
                    </pre>
                  </section>
                ) : null}
              </section>
            </div>
            <footer className="flex h-6 shrink-0 items-center justify-between bg-[#f5b942] px-3 text-[11px] text-[#3a3128]">
              <div className="flex items-center gap-4">
                <span>⑂ {workspace.defaultBranch}</span>
                <span>↻</span>
                <span>× 0</span>
              </div>
              <div className="flex items-center gap-4">
                <span>{activeTab ? collaborationStatus : 'Ready'}</span>
                <span>UTF-8</span>
                <span>{activeTab?.language ?? 'Plain Text'}</span>
                <span>◉ {presence.length}</span>
              </div>
            </footer>

            {isBrainOpen ? (
              <WorkspaceBrain
                workspaceId={workspaceId}
                onOpenFile={(path) => void openFile(path)}
                onClose={() => setIsBrainOpen(false)}
              />
            ) : null}

            {isCollaborationPanelOpen ? (
              <aside className="absolute bottom-6 right-0 top-0 z-10 flex w-80 flex-col border-l border-[#7a6856] bg-[#4e4338] shadow-2xl">
                <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#7a6856] px-4 text-xs font-semibold uppercase tracking-wide">
                  <span>Team collaboration</span>
                  <button
                    className="text-lg text-[#f5b942] hover:text-white"
                    type="button"
                    aria-label="Close collaboration panel"
                    onClick={() => setIsCollaborationPanelOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <div className="border-b border-[#7a6856] px-4 py-3">
                  <h3 className="text-sm font-semibold">Online now ({presence.length})</h3>
                  <div className="mt-2 space-y-2 text-xs text-[#f5b942]">
                    {presence.map((member) => (
                      <p key={member.id}>
                        {member.username}
                        {member.filePath ? ` · ${member.filePath}` : ''}
                      </p>
                    ))}
                  </div>
                </div>
                <div className="flex min-h-0 flex-1 flex-col p-4">
                  <h3 className="text-sm font-semibold">Team chat</h3>
                  {chatError ? (
                    <p className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-100">
                      {chatError}
                    </p>
                  ) : null}
                  <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-auto text-xs">
                    {messages.map((message) => (
                      <p key={message.id}>
                        <span className="font-semibold text-cyan-200">{message.user.username}</span>
                        <br />
                        {message.content}
                      </p>
                    ))}
                  </div>
                  <textarea
                    className="mt-3 h-20 w-full resize-none rounded border border-[#9a846e] bg-[#3a3128] p-2 text-xs outline-none focus:border-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
                    value={chatInput}
                    disabled={!isChatConnected}
                    onChange={(event) => setChatInput(event.target.value)}
                    placeholder={isChatConnected ? 'Message the team' : 'Reconnecting chat…'}
                  />
                  <button
                    className="mt-2 self-end rounded bg-cyan-500 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-[#7a6856] disabled:text-[#9a846e]"
                    type="button"
                    disabled={!isChatConnected || !chatInput.trim()}
                    onClick={sendChat}
                  >
                    Send
                  </button>
                </div>
              </aside>
            ) : null}
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
