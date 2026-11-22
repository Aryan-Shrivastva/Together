import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { io } from 'socket.io-client';
import { MonacoBinding } from 'y-monaco';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

import { useAuth } from '../auth/AuthContext';
import { WorkspaceUpdates } from './WorkspaceUpdates';
import { WorkspaceAssistant } from './WorkspaceAssistant';

loader.config({ monaco });

monaco.editor.defineTheme('together-warm-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '968777', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'd3ae6d' },
    { token: 'string', foreground: 'b7c091' },
    { token: 'number', foreground: 'dfc492' },
  ],
  colors: {
    'editor.background': '#1c1b1f',
    'editor.foreground': '#d8c3a0',
    'editorCursor.foreground': '#ecd8b6',
    'editor.selectionBackground': '#554b43',
    'editor.lineHighlightBackground': '#252321',
    'editorLineNumber.foreground': '#6f655d',
    'editorLineNumber.activeForeground': '#c6a062',
    'editorWidget.background': '#1c1b1f',
    'minimap.background': '#1c1b1f',
  },
});

type Workspace = {
  id: string;
  name: string;
  repoFullName: string;
  defaultBranch: string;
  status: 'CLONING' | 'READY' | 'ERROR';
  role: 'OWNER' | 'COLLABORATOR' | 'VIEWER';
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
type Runtime = {
  status: 'STOPPED' | 'STARTING' | 'RUNNING' | 'ERROR';
  dependencies: 'not detected' | 'not installed' | 'installed';
  kind?: 'node' | 'python-requirements' | 'python-project';
  manifest?: string;
  packages?: DependencyPackage[];
  error?: string;
};
type DependencyPackage = {
  name: string;
  requested: string;
  section: 'dependencies' | 'devDependencies' | 'requirements' | 'pyproject';
};
type DependencyInstallResult = {
  installed: boolean;
  message: string;
  kind?: 'node' | 'python-requirements' | 'python-project';
  manifest?: string;
  packages?: DependencyPackage[];
  durationMs?: number;
};
type DepForgeFinding = {
  package: string;
  ecosystem: 'pypi' | 'npm' | 'gradle';
  current: string | null;
  target: string | null;
  status: 'ok' | 'outdated' | 'deprecated' | 'unpinned' | 'not_found' | 'needs_manual_review';
  reason: string;
  sourceFile: string;
  recommendedAction: 'keep' | 'upgrade' | 'replace' | 'pin' | 'manual_review';
};
type DepForgeRun = {
  runId: string;
  repository: string;
  stage:
    'DISCOVER' | 'ANALYZE' | 'AWAIT_APPROVAL' | 'UPDATE' | 'INSTALL' | 'VERIFY' | 'REPORT' | 'DONE';
  declaredDependencies: Array<{
    name: string;
    currentConstraint: string | null;
    sourceFile: string;
  }>;
  findings: DepForgeFinding[];
  createdAt: string;
  updatedAt: string;
};
type TerminalTasks = { run: boolean; test: boolean };
type Preview = {
  id?: string;
  status: 'STOPPED' | 'STARTING' | 'RUNNING' | 'ERROR';
  url?: string;
  error?: string;
};
type Dataset = { id: string; originalName: string; sizeBytes: number };
type TaskBranch = { id: string; name: string; task: string; branchWorkspaceId?: string | null };

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
  if (response.status === 204) return null;

  const responseText = await response.text();
  let payload: unknown;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    throw new Error(
      'The server returned an unexpected response. Refresh the workspace and try again.',
    );
  }

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
    (value.role === 'OWNER' || value.role === 'COLLABORATOR' || value.role === 'VIEWER')
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

function isRuntime(value: unknown): value is Runtime {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    (value.status === 'STOPPED' ||
      value.status === 'STARTING' ||
      value.status === 'RUNNING' ||
      value.status === 'ERROR') &&
    'dependencies' in value &&
    (value.dependencies === 'not detected' ||
      value.dependencies === 'not installed' ||
      value.dependencies === 'installed') &&
    (!('packages' in value) || Array.isArray(value.packages))
  );
}

function toGitFileStatus(file: {
  path: string;
  index: string;
  working_dir: string;
}): GitFileStatus {
  return { path: file.path, index: file.index, workingDirectory: file.working_dir };
}

function dependencyResultFromRuntime(runtime: Runtime): DependencyInstallResult | null {
  if (!runtime.manifest) return null;
  return {
    installed: runtime.dependencies === 'installed',
    message:
      runtime.dependencies === 'installed'
        ? 'Dependencies are in place in the shared runtime.'
        : 'Dependencies detected. Install them to add them to the shared runtime.',
    manifest: runtime.manifest,
    packages: runtime.packages ?? [],
    ...(runtime.kind ? { kind: runtime.kind } : {}),
    ...(runtime.dependencies === 'installed' ? { durationMs: 0 } : {}),
  };
}

function depforgeFindingKey(finding: Pick<DepForgeFinding, 'package' | 'sourceFile'>): string {
  return `${finding.sourceFile}:${finding.package}`;
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
  const [activeBottomPanel, setActiveBottomPanel] = useState<'terminal' | 'output' | 'depforge'>(
    'terminal',
  );
  const [isCollaborationPanelOpen, setIsCollaborationPanelOpen] = useState(false);
  const [teamPanel, setTeamPanel] = useState<'chat' | 'assistant'>('chat');
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [versionCheckKey, setVersionCheckKey] = useState(0);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitAction, setGitAction] = useState<'commit' | 'pull' | 'push' | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const [gitNotice, setGitNotice] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewAction, setPreviewAction] = useState<'launch' | 'stop' | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [dependencyResult, setDependencyResult] = useState<DependencyInstallResult | null>(null);
  const [depforgeRun, setDepforgeRun] = useState<DepForgeRun | null>(null);
  const [depforgeBusy, setDepforgeBusy] = useState(false);
  const [depforgeError, setDepforgeError] = useState<string | null>(null);
  const [terminalStatus, setTerminalStatus] = useState('Connecting shared terminal…');
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [terminalTasks, setTerminalTasks] = useState<TerminalTasks>({ run: false, test: false });
  const [terminalReconnectVersion, setTerminalReconnectVersion] = useState(0);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetFile, setDatasetFile] = useState<File | null>(null);
  const [configKey, setConfigKey] = useState('');
  const [configValue, setConfigValue] = useState('');
  const [configKeys, setConfigKeys] = useState<string[]>([]);
  const [dataError, setDataError] = useState<string | null>(null);
  const [branchTask, setBranchTask] = useState('');
  const [branches, setBranches] = useState<TaskBranch[]>([]);
  const [branchDiff, setBranchDiff] = useState<string | null>(null);
  const [branchAction, setBranchAction] = useState<{
    id: string;
    action: 'merge' | 'discard';
  } | null>(null);
  const presenceSocketRef = useRef<ReturnType<typeof io> | null>(null);
  const terminalSocketRef = useRef<ReturnType<typeof io> | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const chatPanelOpenRef = useRef(isCollaborationPanelOpen);
  const activeFilePathRef = useRef(activeFilePath);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const isViewer = workspace?.role === 'VIEWER';

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

    const nodes = payload.tree.filter(isFileTreeNode);
    setTree(nodes);
    return nodes;
  }, [workspaceId]);

  async function refreshWorkspaceFiles() {
    // The status endpoint flushes live edits to disk before any view is refreshed.
    const status = await requestJson(`/api/workspaces/${workspaceId}/git/status`);
    if (
      typeof status !== 'object' ||
      status === null ||
      !('status' in status) ||
      !isGitStatus(status.status)
    ) {
      throw new Error('Unable to refresh Git status. Your version notice has been kept.');
    }
    const nodes = await loadTree();
    const paths = new Set<string>();
    const visit = (items: FileTreeNode[]) =>
      items.forEach((item) => {
        if (item.kind === 'file') paths.add(item.path);
        if (item.children) visit(item.children);
      });
    visit(nodes);
    const refreshed = new Map<string, string>();
    if (isViewer) {
      await Promise.all(
        tabs
          .filter((tab) => paths.has(tab.path))
          .map(async (tab) => {
            const file = await requestJson(
              `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent(tab.path)}`,
            );
            if (!isFilePayload(file)) throw new Error('Unable to refresh an open file.');
            refreshed.set(tab.path, file.content);
          }),
      );
    }
    setTabs((current) =>
      current
        .filter((tab) => paths.has(tab.path))
        .map((tab) => ({
          ...tab,
          content: refreshed.get(tab.path) ?? tab.content,
        })),
    );
    setActiveFilePath((current) => (current && paths.has(current) ? current : null));
    setGitStatus({ ...status.status, files: status.status.files.map(toGitFileStatus) });
    setGitNotice('Workspace refreshed. Live edits stay saved in the shared workspace.');
  }

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

  const loadWorkspaceData = useCallback(async () => {
    const [configPayload, datasetPayload] = await Promise.all([
      requestJson(`/api/workspaces/${workspaceId}/config`),
      requestJson(`/api/workspaces/${workspaceId}/datasets`),
    ]);
    if (
      typeof configPayload === 'object' &&
      configPayload &&
      'config' in configPayload &&
      Array.isArray(configPayload.config)
    )
      setConfigKeys(
        configPayload.config
          .filter(
            (item): item is { key: string } =>
              typeof item === 'object' &&
              item !== null &&
              'key' in item &&
              typeof item.key === 'string',
          )
          .map((item) => item.key),
      );
    if (
      typeof datasetPayload === 'object' &&
      datasetPayload &&
      'datasets' in datasetPayload &&
      Array.isArray(datasetPayload.datasets)
    )
      setDatasets(
        datasetPayload.datasets.filter(
          (item): item is Dataset =>
            typeof item === 'object' &&
            item !== null &&
            'id' in item &&
            'originalName' in item &&
            'sizeBytes' in item &&
            typeof item.id === 'string' &&
            typeof item.originalName === 'string' &&
            typeof item.sizeBytes === 'number',
        ),
      );
  }, [workspaceId]);

  const loadBranches = useCallback(async () => {
    const payload = await requestJson(`/api/workspaces/${workspaceId}/branches`);
    if (
      typeof payload === 'object' &&
      payload &&
      'branches' in payload &&
      Array.isArray(payload.branches)
    )
      setBranches(
        payload.branches.filter(
          (item): item is TaskBranch =>
            typeof item === 'object' &&
            item !== null &&
            'id' in item &&
            'name' in item &&
            'task' in item &&
            typeof item.id === 'string' &&
            typeof item.name === 'string' &&
            typeof item.task === 'string',
        ),
      );
  }, [workspaceId]);

  const loadPreview = useCallback(async () => {
    const payload = await requestJson(`/api/workspaces/${workspaceId}/preview`);
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('preview' in payload) ||
      typeof payload.preview !== 'object' ||
      payload.preview === null ||
      !('status' in payload.preview) ||
      !['STOPPED', 'STARTING', 'RUNNING', 'ERROR'].includes(String(payload.preview.status))
    ) {
      throw new Error('The preview response was invalid.');
    }
    setPreview(payload.preview as Preview);
  }, [workspaceId]);

  const startRuntime = useCallback(async () => {
    if (isViewer) return;
    setRuntimeError(null);
    try {
      const payload = await requestJson(`/api/workspaces/${workspaceId}/runtime/start`, {
        method: 'POST',
      });
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('runtime' in payload) ||
        !isRuntime(payload.runtime)
      ) {
        throw new Error('The runtime response was invalid.');
      }
      setRuntime(payload.runtime);
      const runtimeDependencyResult = dependencyResultFromRuntime(payload.runtime);
      if (runtimeDependencyResult) {
        setDependencyResult(runtimeDependencyResult);
        if (payload.runtime.dependencies === 'installed') {
          setActiveBottomPanel('output');
          setIsBottomPanelOpen(true);
        }
      }
    } catch (requestError) {
      setRuntimeError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to start the shared runtime.',
      );
    }
  }, [isViewer, workspaceId]);

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
    if (workspace?.status !== 'READY' || isViewer) {
      return;
    }

    void startRuntime();
  }, [isViewer, startRuntime, workspace?.status]);

  useEffect(() => {
    if (workspace?.status === 'READY')
      void loadWorkspaceData().catch(() =>
        setDataError('Unable to load workspace config or datasets.'),
      );
  }, [loadWorkspaceData, workspace?.status]);

  useEffect(() => {
    if (workspace?.status === 'READY') {
      void loadPreview().catch(() => setPreviewError('Unable to load branch preview status.'));
    }
  }, [loadPreview, workspace?.status]);

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
    const host = terminalHostRef.current;
    if (workspace?.status !== 'READY' || isViewer || !isBottomPanelOpen || !host) return undefined;

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      fontSize: 12,
      theme: {
        background: '#121110',
        foreground: '#d8c3a0',
        cursor: '#ecd8b6',
        selectionBackground: '#554b43',
        black: '#121110',
        brightBlack: '#6f655d',
        yellow: '#d3ae6d',
        brightYellow: '#dfc492',
        green: '#b7c091',
        red: '#b5483a',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    fitAddon.fit();
    const socket = io({ auth: { workspaceId }, withCredentials: true });
    terminalSocketRef.current = socket;
    const resize = () => {
      fitAddon.fit();
      socket.emit('terminal:resize', { columns: terminal.cols, rows: terminal.rows });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const input = terminal.onData((inputData) =>
      socket.emit('terminal:input', { input: inputData }),
    );

    socket.on('connect', () => {
      setTerminalStatus('Shared terminal connected.');
      setTerminalError(null);
      socket.emit('terminal:attach');
      resize();
    });
    socket.on('disconnect', () => setTerminalStatus('Reconnecting shared terminal…'));
    socket.on('connect_error', () => setTerminalStatus('Reconnecting shared terminal…'));
    socket.on('terminal:reset', (payload: { output?: string; tasks?: TerminalTasks }) => {
      terminal.clear();
      if (payload.output) terminal.write(payload.output);
      if (payload.tasks) setTerminalTasks(payload.tasks);
    });
    socket.on('terminal:output', (payload: { output?: string }) => {
      if (payload.output) terminal.write(payload.output);
    });
    socket.on('terminal:status', (payload: { message?: string }) => {
      if (payload.message) terminal.writeln(`\u001b[90m${payload.message}\u001b[0m`);
    });
    socket.on('terminal:error', (payload: { error?: string }) => {
      setTerminalError(payload.error ?? 'Terminal request failed.');
    });

    return () => {
      input.dispose();
      observer.disconnect();
      socket.disconnect();
      terminalSocketRef.current = null;
      terminal.dispose();
    };
  }, [isBottomPanelOpen, isViewer, terminalReconnectVersion, workspace?.status, workspaceId]);

  useEffect(() => {
    if (workspace?.status === 'READY' && isGitPanelOpen) {
      void loadGitStatus();
    }
  }, [isGitPanelOpen, loadGitStatus, workspace?.status]);

  useEffect(() => {
    if (isViewer || !activeFilePath || activeFilePath !== editorPath || !editorInstance || !user) {
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
  }, [activeFilePath, editorInstance, editorPath, isViewer, user, workspaceId]);

  useEffect(() => {
    if (workspace?.status !== 'READY') return undefined;
    const socket = io({ auth: { workspaceId }, withCredentials: true });
    presenceSocketRef.current = socket;
    let disposed = false;
    async function loadChatHistory() {
      try {
        const payload = await requestJson(`/api/workspaces/${workspaceId}/messages`);
        if (
          !disposed &&
          typeof payload === 'object' &&
          payload !== null &&
          'messages' in payload &&
          Array.isArray(payload.messages)
        ) {
          const history = payload.messages as ChatMessage[];
          setMessages((current) =>
            [...new Map([...history, ...current].map((message) => [message.id, message])).values()]
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .slice(-100),
          );
        }
      } catch (cause) {
        if (!disposed)
          setChatError(cause instanceof Error ? cause.message : 'Unable to load chat history.');
      }
    }
    socket.on('connect', () => {
      setIsChatConnected(true);
      setChatError(null);
      socket.emit('presence:update', { filePath: activeFilePathRef.current });
      setVersionCheckKey((current) => current + 1);
      void loadChatHistory();
    });
    socket.on('disconnect', () => {
      setIsChatConnected(false);
      setPresence([]);
      setChatError('Reconnecting team chat…');
    });
    socket.on('connect_error', () => {
      setIsChatConnected(false);
      setChatError('Reconnecting team chat…');
    });
    socket.on('presence:update', (payload: { users?: PresenceUser[] }) =>
      setPresence(payload.users ?? []),
    );
    socket.on('chat:message', (message: ChatMessage) => {
      setMessages((current) =>
        current.some((item) => item.id === message.id)
          ? current
          : [...current, message].slice(-100),
      );
      if (!chatPanelOpenRef.current && message.user.id !== user?.id)
        setUnreadMessages((current) => current + 1);
    });
    socket.on('version:available', () => setVersionCheckKey((current) => current + 1));
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
    return () => {
      disposed = true;
      presenceSocketRef.current = null;
      setIsChatConnected(false);
      socket.disconnect();
    };
  }, [workspace?.status, workspaceId, user?.id]);

  useEffect(() => {
    activeFilePathRef.current = activeFilePath;
    presenceSocketRef.current?.emit('presence:update', { filePath: activeFilePath });
  }, [activeFilePath]);

  useEffect(() => {
    chatPanelOpenRef.current = isCollaborationPanelOpen;
    if (isCollaborationPanelOpen) setUnreadMessages(0);
  }, [isCollaborationPanelOpen]);

  useEffect(() => {
    if (isCollaborationPanelOpen) chatEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, isCollaborationPanelOpen]);

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

  async function installDependencies() {
    await startDepforgeAudit();
  }

  async function startDepforgeAudit() {
    setDepforgeBusy(true);
    setDepforgeError(null);
    setActiveBottomPanel('depforge');
    setIsBottomPanelOpen(true);
    try {
      const payload = await requestJson(`/api/workspaces/${workspaceId}/depforge/runs`, {
        method: 'POST',
      });
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('run' in payload) ||
        typeof payload.run !== 'object' ||
        payload.run === null
      ) {
        throw new Error('The dependency audit response was invalid.');
      }
      const run = payload.run as DepForgeRun;
      setDepforgeRun(run);
    } catch (requestError) {
      setDepforgeError(
        requestError instanceof Error ? requestError.message : 'Dependency audit failed.',
      );
    } finally {
      setDepforgeBusy(false);
    }
  }

  function runTerminalTask(task: 'run' | 'test') {
    setTerminalError(null);
    if (!terminalSocketRef.current?.connected) {
      setTerminalError('The shared terminal is reconnecting. Please wait a moment.');
      return;
    }
    terminalSocketRef.current.emit('terminal:run', { task });
  }

  async function reconnectTerminal() {
    setTerminalError(null);
    await startRuntime();
    setTerminalReconnectVersion((version) => version + 1);
  }

  async function performPreviewAction(action: 'launch' | 'stop') {
    setPreviewAction(action);
    setPreviewError(null);
    try {
      const payload = await requestJson(`/api/workspaces/${workspaceId}/preview`, {
        method: action === 'launch' ? 'POST' : 'DELETE',
      });
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('preview' in payload) ||
        typeof payload.preview !== 'object' ||
        payload.preview === null ||
        !('status' in payload.preview)
      ) {
        throw new Error('The preview response was invalid.');
      }
      setPreview(payload.preview as Preview);
    } catch (requestError) {
      setPreviewError(
        requestError instanceof Error ? requestError.message : 'Unable to update the preview.',
      );
    } finally {
      setPreviewAction(null);
    }
  }

  async function saveConfig() {
    try {
      setDataError(null);
      await requestJson(`/api/workspaces/${workspaceId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: configKey, value: configValue }),
      });
      setConfigKey('');
      setConfigValue('');
      await loadWorkspaceData();
    } catch (e) {
      setDataError(e instanceof Error ? e.message : 'Unable to save config.');
    }
  }
  async function uploadDataset() {
    if (!datasetFile) return;
    try {
      setDataError(null);
      await requestJson(`/api/workspaces/${workspaceId}/datasets`, {
        method: 'POST',
        headers: {
          'Content-Type': datasetFile.type || 'application/octet-stream',
          'X-Dataset-Name': datasetFile.name,
        },
        body: datasetFile,
      });
      setDatasetFile(null);
      await loadWorkspaceData();
    } catch (e) {
      setDataError(e instanceof Error ? e.message : 'Unable to upload dataset.');
    }
  }
  async function deleteDataset(id: string) {
    try {
      await requestJson(`/api/workspaces/${workspaceId}/datasets/${id}`, { method: 'DELETE' });
      await loadWorkspaceData();
    } catch (e) {
      setDataError(e instanceof Error ? e.message : 'Unable to delete dataset.');
    }
  }
  async function createBranch() {
    try {
      const payload = await requestJson(`/api/workspaces/${workspaceId}/branches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: branchTask }),
      });
      if (typeof payload === 'object' && payload && 'branch' in payload) {
        setBranchTask('');
        await loadBranches();
      }
    } catch (e) {
      setGitError(e instanceof Error ? e.message : 'Unable to create branch.');
    }
  }
  async function showDiff(branch: TaskBranch) {
    try {
      const payload = await requestJson(
        `/api/workspaces/${workspaceId}/branches/${branch.id}/diff`,
      );
      if (
        typeof payload === 'object' &&
        payload &&
        'diff' in payload &&
        typeof payload.diff === 'string'
      )
        setBranchDiff(payload.diff || 'No changes compared with main.');
    } catch (e) {
      setGitError(e instanceof Error ? e.message : 'Unable to load branch diff.');
    }
  }

  async function performBranchAction(branch: TaskBranch, action: 'merge' | 'discard') {
    const message =
      action === 'merge'
        ? `Merge ${branch.name} into main? The main workspace must be clean, and the task branch will be cleaned up after a successful merge.`
        : `Discard ${branch.name}? Its worktree, preview, runtime, and unmerged changes will be removed.`;
    if (!window.confirm(message)) return;

    setBranchAction({ id: branch.id, action });
    setGitError(null);
    setGitNotice(null);
    try {
      await requestJson(
        `/api/workspaces/${workspaceId}/branches/${branch.id}${action === 'merge' ? '/merge' : ''}`,
        { method: action === 'merge' ? 'POST' : 'DELETE' },
      );
      setBranchDiff(null);
      await Promise.all([loadBranches(), loadGitStatus()]);
      setGitNotice(
        action === 'merge' ? 'Branch merged into main.' : 'Branch discarded and cleaned up.',
      );
    } catch (e) {
      setGitError(e instanceof Error ? e.message : `Unable to ${action} branch.`);
    } finally {
      setBranchAction(null);
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
      className="h-screen overflow-hidden bg-[#161412] text-slate-100"
      onClick={() => setContextMenu(null)}
    >
      <section className="flex h-full min-w-0 flex-col">
        <header className="flex h-14 shrink-0 items-center border-b border-[#51473b] bg-gradient-to-r from-[#28231e] via-[#24221f] to-[#1c2424] px-4 text-xs text-[#f0e4c5]">
          <div className="flex min-w-0 items-center gap-4">
            <span
              className="grid h-5 w-5 place-items-center text-base text-cyan-300"
              aria-label="Together"
            >
              ◇
            </span>
            <span className="hidden text-sm font-semibold tracking-wide text-[#f6ead1] sm:inline">
              Together <span className="font-normal text-[#9c8f7f]">/ workspace</span>
            </span>
          </div>
          <p className="mx-auto max-w-[35%] truncate rounded-full border border-[#665746] bg-[#171714] px-4 py-1.5 text-center font-medium text-[#f1dfbc]">
            {workspace?.name ?? 'Together'}
          </p>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              className={`grid h-7 w-7 place-items-center rounded text-base hover:bg-[#45413a] hover:text-white ${isExplorerOpen ? 'text-cyan-200' : 'text-[#a89984]'}`}
              title="Toggle Explorer"
              type="button"
              aria-label="Toggle Explorer"
              onClick={() => setIsExplorerOpen((open) => !open)}
            >
              ▯
            </button>
            <button
              className={`grid h-7 w-7 place-items-center rounded text-base hover:bg-[#45413a] hover:text-white ${isBottomPanelOpen ? 'text-cyan-200' : 'text-[#a89984]'}`}
              title="Toggle bottom panel"
              type="button"
              aria-label="Toggle bottom panel"
              onClick={() => setIsBottomPanelOpen((open) => !open)}
            >
              ▰
            </button>
            <button
              className={`flex h-7 items-center gap-2 rounded px-2 text-xs hover:bg-[#45413a] hover:text-white ${isCollaborationPanelOpen ? 'bg-[#45413a] text-cyan-200' : 'text-[#a89984]'}`}
              title="See online teammates, their files, and team chat"
              type="button"
              aria-label={`Team chat, ${presence.length} online, ${unreadMessages} unread messages`}
              aria-expanded={isCollaborationPanelOpen}
              onClick={() => setIsCollaborationPanelOpen((open) => !open)}
            >
              <span className={isChatConnected ? 'text-emerald-300' : 'text-amber-300'}>●</span>
              Team · {presence.length}
              {unreadMessages > 0 ? (
                <span className="rounded-full bg-cyan-300 px-1.5 text-[#161412]">
                  {unreadMessages > 99 ? '99+' : unreadMessages}
                </span>
              ) : null}
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

        {workspace?.status === 'READY' ? (
          <WorkspaceUpdates
            workspaceId={workspaceId}
            checkKey={versionCheckKey}
            onRefresh={refreshWorkspaceFiles}
          />
        ) : null}

        {error ? (
          <p className="absolute left-1/2 top-12 z-20 -translate-x-1/2 rounded border border-rose-500/50 bg-[#2a1614] px-4 py-2 text-sm text-rose-200 shadow-xl">
            {error}
          </p>
        ) : null}
        {liveUpdateError ? (
          <p className="absolute left-1/2 top-12 z-20 -translate-x-1/2 rounded border border-amber-500/50 bg-[#2a2218] px-4 py-2 text-sm text-amber-200 shadow-xl">
            {liveUpdateError}
          </p>
        ) : null}
        {collaborationStatus === 'Reconnecting collaboration…' ? (
          <p className="absolute left-1/2 top-24 z-20 -translate-x-1/2 rounded border border-amber-500/50 bg-[#2a2218] px-4 py-2 text-sm text-amber-200 shadow-xl">
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
          <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#1c1b19]">
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <nav
                className="flex w-12 shrink-0 flex-col items-center border-r border-[#45413a] bg-[#1c1b19] py-2 text-xl text-[#f0e4c5]"
                aria-label="Activity bar"
              >
                <button
                  className={`grid h-12 w-full place-items-center ${!isGitPanelOpen ? 'border-l-2 border-cyan-300 bg-[#2a2724] text-cyan-200' : 'text-[#a89984] hover:bg-[#2a2724] hover:text-white'}`}
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
                  className={`grid h-12 w-full place-items-center ${isGitPanelOpen ? 'border-l-2 border-cyan-300 bg-[#2a2724] text-cyan-200' : 'text-[#a89984] hover:bg-[#2a2724] hover:text-white'}`}
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
                  className="mt-auto grid h-12 w-full place-items-center text-[#a89984] hover:bg-[#2a2724] hover:text-white"
                  title="Team collaboration"
                  type="button"
                  onClick={() => setIsCollaborationPanelOpen((open) => !open)}
                >
                  ◉
                </button>
              </nav>

              {isExplorerOpen && isGitPanelOpen ? (
                <aside className="flex w-72 shrink-0 flex-col border-r border-[#45413a] bg-[#232220] text-[#f0e4c5]">
                  <div className="flex h-9 shrink-0 items-center justify-between px-5 text-[11px] font-semibold uppercase tracking-wide">
                    <h2>Source Control</h2>
                    <button
                      className="text-lg leading-none text-[#d4bd99] hover:text-white"
                      type="button"
                      title="Refresh Git status"
                      aria-label="Refresh Git status"
                      onClick={() => void loadGitStatus()}
                    >
                      ↻
                    </button>
                  </div>
                  <div className="max-h-[35%] overflow-y-auto border-b border-[#51483e] px-5 py-4 text-xs text-[#d4bd99]">
                    <p className="truncate font-medium text-[#fbf1c7]">{workspace.repoFullName}</p>
                    <p className="mt-1">
                      {gitStatus?.current ?? workspace.defaultBranch}
                      {gitStatus?.ahead ? ` · ↑${gitStatus.ahead}` : ''}
                      {gitStatus?.behind ? ` · ↓${gitStatus.behind}` : ''}
                    </p>
                    {isViewer ? (
                      <p className="mt-2 rounded border border-amber-400/40 bg-amber-400/10 p-2 text-amber-200">
                        Viewer access — this workspace is read-only.
                      </p>
                    ) : null}
                    <div className="mt-2 flex gap-2">
                      <a
                        className="rounded border border-[#6b655c] px-2 py-1 text-[10px] hover:border-cyan-400"
                        href={`/api/workspaces/${workspaceId}/export`}
                      >
                        Export ZIP
                      </a>
                      <a
                        className="rounded border border-[#6b655c] px-2 py-1 text-[10px] hover:border-cyan-400"
                        href={`/api/workspaces/${workspaceId}/activity`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Activity JSON
                      </a>
                    </div>
                  </div>
                  <div className="border-b border-[#45413a] p-3 text-xs">
                    <p className="font-semibold text-[#fbf1c7]">Task branches</p>
                    <div className="mt-2 flex gap-1">
                      <input
                        className="min-w-0 flex-1 rounded border border-[#6b655c] bg-[#1c1b19] px-2 py-1"
                        placeholder="task-name"
                        value={branchTask}
                        onChange={(event) => setBranchTask(event.target.value)}
                      />
                      <button
                        className="rounded border border-[#6b655c] px-2 hover:border-cyan-400"
                        type="button"
                        disabled={isViewer || !branchTask.trim()}
                        onClick={() => void createBranch()}
                      >
                        Create
                      </button>
                    </div>
                    <button
                      className="mt-2 text-[#d4bd99] hover:text-[#fbf1c7]"
                      type="button"
                      onClick={() => void loadBranches()}
                    >
                      Refresh branches
                    </button>
                    {branches.map((branch) => (
                      <div key={branch.id} className="mt-1 flex gap-1">
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left text-[#d4bd99] hover:text-[#fbf1c7]"
                          onClick={() => void showDiff(branch)}
                        >
                          {branch.name}
                        </button>
                        {branch.branchWorkspaceId ? (
                          <button
                            type="button"
                            className="text-cyan-300"
                            onClick={() =>
                              window.location.assign(`/workspaces/${branch.branchWorkspaceId}`)
                            }
                          >
                            Open
                          </button>
                        ) : null}
                        {workspace.role === 'OWNER' ? (
                          <>
                            <button
                              type="button"
                              className="text-emerald-300 disabled:opacity-40"
                              disabled={branchAction !== null}
                              onClick={() => void performBranchAction(branch, 'merge')}
                            >
                              {branchAction?.id === branch.id && branchAction.action === 'merge'
                                ? 'Merging…'
                                : 'Merge'}
                            </button>
                            <button
                              type="button"
                              className="text-rose-300 disabled:opacity-40"
                              disabled={branchAction !== null}
                              onClick={() => void performBranchAction(branch, 'discard')}
                            >
                              {branchAction?.id === branch.id && branchAction.action === 'discard'
                                ? 'Discarding…'
                                : 'Discard'}
                            </button>
                          </>
                        ) : null}
                      </div>
                    ))}
                    {workspace.role !== 'OWNER' ? (
                      <p className="mt-2 text-[10px] text-[#8e8373]">
                        Only the workspace owner can merge or discard task branches.
                      </p>
                    ) : null}
                    {branchDiff !== null ? (
                      <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap text-[10px] text-[#a89984]">
                        {branchDiff}
                      </pre>
                    ) : null}
                  </div>
                  <div className="border-b border-[#45413a] p-3">
                    <label className="sr-only" htmlFor="commit-message">
                      Commit message
                    </label>
                    <textarea
                      id="commit-message"
                      className="h-20 w-full resize-none rounded border border-[#6b655c] bg-[#1c1b19] p-2 text-xs outline-none placeholder:text-[#8e8373] focus:border-cyan-400"
                      value={commitMessage}
                      maxLength={500}
                      onChange={(event) => setCommitMessage(event.target.value)}
                      placeholder="Message (required)"
                    />
                    <button
                      className="mt-2 w-full rounded bg-cyan-500 px-3 py-2 text-xs font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-[#45413a] disabled:text-[#6b655c]"
                      type="button"
                      disabled={isViewer || gitAction !== null || !commitMessage.trim()}
                      onClick={() => void performGitAction('commit')}
                    >
                      {gitAction === 'commit' ? 'Committing…' : 'Commit all changes'}
                    </button>
                  </div>
                  <div className="flex shrink-0 gap-2 border-b border-[#45413a] p-3">
                    <button
                      className="flex-1 rounded border border-[#6b655c] px-2 py-2 text-xs hover:border-cyan-400 disabled:cursor-not-allowed disabled:text-[#8e8373]"
                      type="button"
                      disabled={isViewer || gitAction !== null}
                      onClick={() => void performGitAction('pull')}
                    >
                      {gitAction === 'pull' ? 'Pulling…' : 'Pull'}
                    </button>
                    <button
                      className="flex-1 rounded border border-[#6b655c] px-2 py-2 text-xs hover:border-cyan-400 disabled:cursor-not-allowed disabled:text-[#8e8373]"
                      type="button"
                      title={
                        workspace.role === 'OWNER'
                          ? 'Push to GitHub'
                          : 'Only the workspace owner can push'
                      }
                      disabled={isViewer || gitAction !== null || workspace.role !== 'OWNER'}
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
                            className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-[#1c1b19]"
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
                    <p className="border-t border-[#45413a] p-3 text-xs text-[#8e8373]">
                      Only the workspace owner can push to GitHub.
                    </p>
                  ) : null}
                </aside>
              ) : isExplorerOpen ? (
                <aside className="flex w-72 shrink-0 flex-col border-r border-[#45413a] bg-[#232220] text-[#f0e4c5]">
                  <div className="flex h-9 shrink-0 items-center justify-between px-5 text-[11px] font-semibold uppercase tracking-wide">
                    <h2>Explorer</h2>
                    <span className="text-lg leading-none text-[#d4bd99]">···</span>
                  </div>
                  <div className="flex h-7 shrink-0 items-center gap-1 bg-[#1c1b19] px-3 text-xs font-semibold">
                    <span className="text-cyan-200">⌄</span>
                    <span className="truncate">{workspace.name}</span>
                  </div>
                  <div className="flex shrink-0 gap-1 border-b border-[#45413a] px-3 py-2">
                    <button
                      className="grid h-7 flex-1 place-items-center rounded border border-[#6b655c] text-xs hover:border-cyan-400 hover:text-cyan-200"
                      type="button"
                      disabled={isViewer}
                      onClick={() => void createEntry('directory', null)}
                    >
                      New folder
                    </button>
                    <button
                      className="grid h-7 flex-1 place-items-center rounded bg-cyan-500 text-xs font-semibold text-slate-950 hover:bg-cyan-300"
                      type="button"
                      disabled={isViewer}
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
                  <div className="shrink-0 border-t border-[#45413a] text-xs text-[#d4bd99]">
                    <p className="border-b border-[#45413a] px-4 py-2">› Outline</p>
                    <p className="border-b border-[#45413a] px-4 py-2">› Timeline</p>
                    <p className="px-4 py-2">› Git</p>
                  </div>
                </aside>
              ) : null}

              <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#1c1b19]">
                <div className="flex h-9 shrink-0 overflow-x-auto border-b border-[#45413a] bg-[#232220]">
                  {tabs.length === 0 ? (
                    <p className="px-4 py-2 text-xs text-[#d4bd99]">
                      Select a file to open it in the editor.
                    </p>
                  ) : (
                    tabs.map((tab) => (
                      <div
                        key={tab.path}
                        className={`flex h-9 shrink-0 items-center gap-2 border-r border-[#45413a] px-3 text-xs ${
                          tab.path === activeFilePath
                            ? 'border-t-2 border-t-cyan-400 bg-[#1c1b19] text-[#fff8e8]'
                            : 'bg-[#161412] text-[#d4bd99] hover:bg-[#1c1b19]'
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
                      theme="together-warm-dark"
                      defaultValue={activeTab.content}
                      {...(isViewer ? { value: activeTab.content } : {})}
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
                        readOnly:
                          isViewer || collaborationStatus !== 'Live collaboration connected.',
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
                  <section className="h-64 shrink-0 border-t border-[#45413a] bg-[#161412]">
                    <div className="flex h-9 items-center gap-5 border-b border-[#45413a] px-4 text-[11px] font-semibold uppercase tracking-wider text-[#d4bd99]">
                      <button
                        className={
                          activeBottomPanel === 'output'
                            ? 'border-b-2 border-cyan-300 py-[10px] text-[#fbf1c7]'
                            : 'py-[10px]'
                        }
                        type="button"
                        onClick={() => setActiveBottomPanel('output')}
                      >
                        Output
                      </button>
                      <button
                        className={
                          activeBottomPanel === 'depforge'
                            ? 'border-b-2 border-cyan-300 py-[10px] text-[#fbf1c7]'
                            : 'py-[10px]'
                        }
                        type="button"
                        onClick={() => setActiveBottomPanel('depforge')}
                      >
                        Dependencies
                      </button>
                      <button
                        className={
                          activeBottomPanel === 'terminal'
                            ? 'border-b-2 border-cyan-300 py-[10px] text-[#fbf1c7]'
                            : 'py-[10px]'
                        }
                        type="button"
                        onClick={() => setActiveBottomPanel('terminal')}
                      >
                        Terminal
                      </button>
                    </div>
                    {activeBottomPanel === 'depforge' ? (
                      <div className="h-[12.75rem] overflow-y-auto p-4 text-xs text-[#d4bd99]">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="font-semibold text-[#fbf1c7]">
                              Dependency change preview
                            </p>
                            <p className="mt-1 text-[#a89984]">
                              Before → proposed versions are shown for demonstration only. No files
                              are edited and nothing is installed from this preview.
                            </p>
                          </div>
                          {!depforgeRun || depforgeRun.stage === 'DONE' ? (
                            <button
                              className="shrink-0 rounded border border-cyan-400 px-2 py-1.5 text-[10px] font-semibold text-cyan-100 hover:bg-cyan-400/10 disabled:opacity-40"
                              type="button"
                              disabled={isViewer || depforgeBusy}
                              onClick={() => void startDepforgeAudit()}
                            >
                              {depforgeBusy ? 'Working…' : 'Preview again'}
                            </button>
                          ) : null}
                        </div>
                        {depforgeRun ? (
                          <>
                            <p className="mt-2 text-[10px] text-[#8e8373]">
                              {depforgeRun.repository} · Stage: {depforgeRun.stage} ·{' '}
                              {depforgeRun.findings.length} findings
                            </p>
                            <div className="mt-2 overflow-x-auto rounded border border-[#45413a] bg-[#1c1b19]">
                              <table className="w-full text-left text-[10px]">
                                <thead className="text-[#fbf1c7]">
                                  <tr>
                                    <th className="p-2">Manifest</th>
                                    <th className="p-2">Package</th>
                                    <th className="p-2">Current → proposed</th>
                                    <th className="p-2">Status</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {depforgeRun.findings.map((finding) => {
                                    const key = depforgeFindingKey(finding);
                                    return (
                                      <tr key={key} className="border-t border-[#45413a]">
                                        <td className="p-2 font-mono text-[#d4bd99]">
                                          {finding.sourceFile}
                                        </td>
                                        <td className="p-2 font-mono text-cyan-200">
                                          {finding.package}
                                        </td>
                                        <td className="p-2">
                                          {finding.current ?? '—'} → {finding.target ?? '—'}
                                        </td>
                                        <td className="p-2">
                                          <span className="text-amber-200">{finding.status}</span>
                                          <span className="ml-1 text-[#a89984]">
                                            {finding.reason}
                                          </span>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                            <p className="mt-3 text-cyan-200">
                              Preview only: no dependency files were changed.
                            </p>
                          </>
                        ) : (
                          <p className="mt-4 text-[#a89984]">
                            Start a preview to compare the current and proposed dependency versions.
                          </p>
                        )}
                        {depforgeError ? (
                          <p className="mt-2 text-rose-300">{depforgeError}</p>
                        ) : null}
                      </div>
                    ) : activeBottomPanel === 'output' ? (
                      <div className="h-[12.75rem] overflow-y-auto p-4 text-xs text-[#d4bd99]">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="font-semibold text-[#fbf1c7]">
                              Dependency installation results
                            </p>
                            <p className="mt-1 text-[#a89984]">
                              {dependencyResult?.message ??
                                'Install dependencies to see the results.'}
                            </p>
                          </div>
                          {dependencyResult?.durationMs !== undefined ? (
                            <span className="shrink-0 text-emerald-300">
                              {dependencyResult.durationMs === 0
                                ? 'reused cached install'
                                : `${(dependencyResult.durationMs / 1000).toFixed(1)}s`}
                            </span>
                          ) : null}
                        </div>
                        {dependencyResult?.manifest ? (
                          <p className="mt-2 text-[10px] text-[#8e8373]">
                            Manifest: {dependencyResult.manifest} · The editor is showing the
                            manifest file.
                          </p>
                        ) : null}
                        <div className="mt-3 rounded border border-[#45413a] bg-[#1c1b19] p-2">
                          <p className="mb-1 font-semibold text-[#fbf1c7]">
                            {dependencyResult?.packages?.length ?? 0} declared dependencies
                          </p>
                          {dependencyResult?.packages?.length ? (
                            <div className="max-h-28 overflow-y-auto font-mono text-[11px]">
                              {dependencyResult.packages.map((dependency) => (
                                <p key={`${dependency.section}:${dependency.name}`}>
                                  <span className="text-cyan-200">{dependency.section}</span>:{' '}
                                  {dependency.name} {dependency.requested}
                                </p>
                              ))}
                            </div>
                          ) : (
                            <p className="text-[#a89984]">
                              The installer completed, but this manifest did not contain direct
                              dependency lines.
                            </p>
                          )}
                        </div>
                        <button
                          className="mt-3 rounded border border-[#6b655c] px-3 py-1.5 text-[10px] font-semibold hover:border-cyan-400"
                          type="button"
                          onClick={() => setActiveBottomPanel('terminal')}
                        >
                          Back to terminal
                        </button>
                      </div>
                    ) : (
                      <div className="flex h-[12.75rem] min-h-0">
                        <div ref={terminalHostRef} className="min-w-0 flex-1 overflow-hidden p-3" />
                        <aside className="w-52 shrink-0 overflow-y-auto border-l border-[#45413a] p-3 text-xs text-[#d4bd99]">
                          <p className="font-semibold text-[#fbf1c7]">
                            Runtime:{' '}
                            <span
                              className={
                                runtime?.status === 'RUNNING'
                                  ? 'text-emerald-300'
                                  : 'text-amber-200'
                              }
                            >
                              {runtime?.status.toLowerCase() ?? 'starting'}
                            </span>
                          </p>
                          <p className="mt-1">
                            Dependencies: {runtime?.dependencies ?? 'checking'}
                          </p>
                          <div className="mt-2 border-y border-[#45413a] py-2">
                            <p className="font-semibold text-[#fbf1c7]">Datasets</p>
                            <label className="mt-1 block w-full cursor-pointer rounded border border-[#6b655c] px-2 py-1.5 text-center text-[10px] font-semibold hover:border-cyan-400">
                              {datasetFile ? datasetFile.name : 'Choose dataset file'}
                              <input
                                className="sr-only"
                                type="file"
                                onChange={(event) =>
                                  setDatasetFile(event.target.files?.[0] ?? null)
                                }
                              />
                            </label>
                            <button
                              className="mt-1 w-full rounded border border-[#6b655c] px-2 py-1.5 text-[10px] font-semibold hover:border-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
                              type="button"
                              disabled={isViewer || !datasetFile}
                              onClick={() => void uploadDataset()}
                            >
                              Upload selected file
                            </button>
                          </div>
                          <p className="mt-2 text-[#a89984]">{terminalStatus}</p>
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <button
                              className="rounded border border-[#6b655c] px-2 py-1.5 font-semibold hover:border-cyan-400 disabled:opacity-40"
                              type="button"
                              disabled={isViewer || !terminalTasks.run}
                              onClick={() => runTerminalTask('run')}
                            >
                              Run
                            </button>
                            <button
                              className="rounded border border-[#6b655c] px-2 py-1.5 font-semibold hover:border-cyan-400 disabled:opacity-40"
                              type="button"
                              disabled={isViewer || !terminalTasks.test}
                              onClick={() => runTerminalTask('test')}
                            >
                              Test
                            </button>
                          </div>
                          <button
                            className="mt-2 w-full rounded border border-[#6b655c] px-2 py-1.5 font-semibold hover:border-cyan-400 disabled:opacity-40"
                            type="button"
                            disabled={isViewer || depforgeBusy || runtime?.status !== 'RUNNING'}
                            onClick={() => void installDependencies()}
                          >
                            {depforgeBusy ? 'Preparing preview…' : 'Install dependencies (preview)'}
                          </button>
                          <button
                            className="mt-2 w-full rounded border border-[#6b655c] px-2 py-1.5 font-semibold hover:border-cyan-400"
                            type="button"
                            disabled={isViewer}
                            onClick={() => void reconnectTerminal()}
                          >
                            Start / reconnect terminal
                          </button>
                          <div className="mt-3 border-t border-[#45413a] pt-2">
                            <p className="font-semibold text-[#fbf1c7]">Branch preview</p>
                            {workspace.defaultBranch.startsWith('together/') ? (
                              <>
                                <p className="mt-1 text-[10px] text-[#a89984]">
                                  {preview?.status.toLowerCase() ?? 'stopped'} · isolated container
                                </p>
                                <button
                                  className="mt-2 w-full rounded border border-[#6b655c] px-2 py-1.5 text-[10px] font-semibold hover:border-cyan-400 disabled:opacity-40"
                                  type="button"
                                  disabled={isViewer || previewAction !== null}
                                  onClick={() => void performPreviewAction('launch')}
                                >
                                  {previewAction === 'launch' ? 'Launching…' : 'Launch preview'}
                                </button>
                                {preview?.url ? (
                                  <button
                                    className="mt-1 w-full rounded border border-cyan-400 px-2 py-1.5 text-[10px] font-semibold text-cyan-100"
                                    type="button"
                                    onClick={() =>
                                      window.open(preview.url, '_blank', 'noopener,noreferrer')
                                    }
                                  >
                                    Open preview
                                  </button>
                                ) : null}
                                {preview?.status === 'RUNNING' ? (
                                  <button
                                    className="mt-1 w-full rounded border border-[#6b655c] px-2 py-1.5 text-[10px] font-semibold hover:border-rose-300 disabled:opacity-40"
                                    type="button"
                                    disabled={isViewer || previewAction !== null}
                                    onClick={() => void performPreviewAction('stop')}
                                  >
                                    {previewAction === 'stop' ? 'Stopping…' : 'Stop preview'}
                                  </button>
                                ) : null}
                              </>
                            ) : (
                              <p className="mt-1 text-[10px] text-[#8e8373]">
                                Create and open a task branch to launch an isolated preview.
                              </p>
                            )}
                            {previewError || preview?.error ? (
                              <p className="mt-2 text-rose-300">{previewError ?? preview?.error}</p>
                            ) : null}
                          </div>
                          {runtimeError ? (
                            <p className="mt-2 text-rose-300">{runtimeError}</p>
                          ) : null}
                          {terminalError ? (
                            <p className="mt-2 text-rose-300">{terminalError}</p>
                          ) : null}
                          <p className="mt-2 text-[10px] text-[#8e8373]">
                            Run/Test use package scripts or safe command arrays in together.json.
                          </p>
                          <div className="mt-3 border-t border-[#45413a] pt-2">
                            <p className="font-semibold text-[#fbf1c7]">Shared config</p>
                            <input
                              className="mt-1 w-full rounded border border-[#6b655c] bg-[#1c1b19] p-1 text-[10px]"
                              placeholder="KEY_NAME"
                              value={configKey}
                              onChange={(event) => setConfigKey(event.target.value.toUpperCase())}
                            />
                            <input
                              className="mt-1 w-full rounded border border-[#6b655c] bg-[#1c1b19] p-1 text-[10px]"
                              type="password"
                              placeholder="Secret value"
                              value={configValue}
                              onChange={(event) => setConfigValue(event.target.value)}
                            />
                            <button
                              className="mt-1 w-full rounded border border-[#6b655c] px-2 py-1 text-[10px]"
                              type="button"
                              disabled={isViewer || !configKey || !configValue}
                              onClick={() => void saveConfig()}
                            >
                              Save encrypted
                            </button>
                            {configKeys.length ? (
                              <p className="mt-1 truncate text-[10px] text-[#a89984]">
                                {configKeys.join(', ')}
                              </p>
                            ) : null}
                          </div>
                          <div className="mt-3 border-t border-[#45413a] pt-2">
                            <p className="font-semibold text-[#fbf1c7]">Datasets</p>
                            {datasets.map((dataset) => (
                              <div key={dataset.id} className="mt-1 flex gap-1 text-[10px]">
                                <span className="min-w-0 flex-1 truncate">
                                  {dataset.originalName}
                                </span>
                                <button
                                  type="button"
                                  className="text-rose-300"
                                  disabled={isViewer}
                                  onClick={() => void deleteDataset(dataset.id)}
                                >
                                  Delete
                                </button>
                              </div>
                            ))}
                          </div>
                          {dataError ? <p className="mt-2 text-rose-300">{dataError}</p> : null}
                        </aside>
                      </div>
                    )}
                  </section>
                ) : null}
              </section>
            </div>
            <footer className="flex h-7 shrink-0 items-center justify-between border-t border-[#51483e] bg-[#282824] px-4 text-[11px] text-[#d5c7ab]">
              <div className="flex items-center gap-4">
                <span>⑂ {workspace.defaultBranch}</span>
              </div>
              <div className="flex items-center gap-4">
                <span>{activeTab ? collaborationStatus : 'Ready'}</span>

                <span>{activeTab?.language ?? 'Plain Text'}</span>
                <button type="button" onClick={() => setIsCollaborationPanelOpen(true)}>
                  ● {presence.length} online
                </button>
              </div>
            </footer>

            {isCollaborationPanelOpen ? (
              <aside className="absolute bottom-7 right-0 top-0 z-10 flex w-[min(24rem,100%)] flex-col border-l border-[#5a5146] bg-[#242320] shadow-[-18px_0_50px_rgba(0,0,0,0.35)]">
                <div className="flex h-14 shrink-0 items-center justify-between border-b border-[#51483e] bg-[#2b2824] px-5 text-xs font-semibold uppercase tracking-[0.14em]">
                  <span>Team collaboration</span>
                  <button
                    className="text-lg text-[#d4bd99] hover:text-white"
                    type="button"
                    aria-label="Close collaboration panel"
                    onClick={() => setIsCollaborationPanelOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <div className="flex gap-4 border-b border-[#51483e] px-5 text-xs">
                  <button
                    type="button"
                    aria-pressed={teamPanel === 'chat'}
                    className={
                      teamPanel === 'chat'
                        ? 'border-b-2 border-cyan-300 py-3 text-cyan-100'
                        : 'py-3 text-[#a89984]'
                    }
                    onClick={() => setTeamPanel('chat')}
                  >
                    Team chat
                  </button>
                  <button
                    type="button"
                    aria-pressed={teamPanel === 'assistant'}
                    className={
                      teamPanel === 'assistant'
                        ? 'border-b-2 border-cyan-300 py-3 text-cyan-100'
                        : 'py-3 text-[#a89984]'
                    }
                    onClick={() => setTeamPanel('assistant')}
                  >
                    AI assistant
                  </button>
                </div>
                {teamPanel === 'assistant' ? (
                  <WorkspaceAssistant workspaceId={workspaceId} isViewer={isViewer} />
                ) : (
                  <>
                    <div className="max-h-[35%] overflow-y-auto border-b border-[#51483e] px-5 py-4">
                      <h3 className="text-sm font-semibold">Online now ({presence.length})</h3>
                      <div className="mt-2 space-y-2 text-xs text-[#d4bd99]">
                        {presence.map((member) => (
                          <div key={member.id} className="flex items-start gap-2">
                            <img src={member.avatarUrl} alt="" className="h-7 w-7 rounded-full" />
                            <div className="min-w-0">
                              <p>
                                <span className="text-emerald-300">●</span> {member.username}
                                {member.id === user?.id ? ' (you)' : ''}
                              </p>
                              {member.filePath ? (
                                <button
                                  type="button"
                                  className="block max-w-full truncate text-cyan-200 hover:underline"
                                  title={`Open ${member.filePath}`}
                                  onClick={() => void openFile(member.filePath!)}
                                >
                                  {member.filePath}
                                </button>
                              ) : (
                                <p className="text-[#a89984]">Browsing workspace</p>
                              )}
                            </div>
                          </div>
                        ))}
                        {!presence.length ? (
                          <p>
                            {isChatConnected
                              ? 'No teammates online yet.'
                              : 'Connecting to your team…'}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col p-4">
                      <h3 className="text-sm font-semibold">Team chat</h3>
                      <p className="mt-1 text-[10px] text-[#a89984]">
                        Edits auto-save to the shared workspace. Commit to save a version; push to
                        back it up on GitHub.
                      </p>
                      {chatError ? (
                        <p className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-100">
                          {chatError}
                        </p>
                      ) : null}
                      <div
                        role="log"
                        aria-label="Team messages"
                        aria-live="polite"
                        className="mt-3 min-h-0 flex-1 space-y-3 overflow-auto rounded-xl border border-[#45413a] bg-[#1b1b19] p-3 text-xs"
                      >
                        {!messages.length ? (
                          <p className="text-[#a89984]">
                            Start a conversation with your team. Messages are saved for when
                            teammates return.
                          </p>
                        ) : null}
                        {messages.map((message) => (
                          <p
                            key={message.id}
                            className="rounded-lg border border-[#403d37] bg-[#292824] p-3 whitespace-pre-wrap break-words leading-relaxed"
                          >
                            <span className="font-semibold text-cyan-200">
                              {message.user.username}
                            </span>
                            <time
                              dateTime={message.createdAt}
                              title={new Date(message.createdAt).toLocaleString()}
                              className="ml-2 text-[10px] text-[#a89984]"
                            >
                              {new Date(message.createdAt).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </time>
                            <br />
                            {message.content}
                          </p>
                        ))}
                        <div ref={chatEndRef} />
                      </div>
                      <textarea
                        className="mt-3 h-20 w-full resize-none rounded border border-[#6b655c] bg-[#1c1b19] p-2 text-xs outline-none focus:border-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
                        value={chatInput}
                        disabled={isViewer || !isChatConnected}
                        aria-label="Message your team"
                        maxLength={5000}
                        onChange={(event) => setChatInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (
                            event.key === 'Enter' &&
                            !event.shiftKey &&
                            !event.nativeEvent.isComposing
                          ) {
                            event.preventDefault();
                            sendChat();
                          }
                        }}
                        placeholder={
                          isViewer
                            ? 'Viewer access — chat is read-only'
                            : isChatConnected
                              ? 'Message the team · Enter to send'
                              : 'Reconnecting chat…'
                        }
                      />
                      <button
                        className="mt-2 self-end rounded bg-cyan-500 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-[#45413a] disabled:text-[#6b655c]"
                        type="button"
                        disabled={isViewer || !isChatConnected || !chatInput.trim()}
                        onClick={sendChat}
                      >
                        Send
                      </button>
                    </div>
                  </>
                )}
              </aside>
            ) : null}
          </section>
        ) : null}
      </section>

      {!isViewer && contextMenu ? (
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
