export const dependencyRunStages = [
  'DISCOVER',
  'ANALYZE',
  'AWAIT_APPROVAL',
  'UPDATE',
  'INSTALL',
  'VERIFY',
  'REPORT',
  'DONE',
] as const;

export type DependencyRunStage = (typeof dependencyRunStages)[number];
export type DependencyEcosystem = 'pypi' | 'npm' | 'gradle';
export type DependencyRunStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'ABORTED';

export type DeclaredDependency = {
  name: string;
  currentConstraint: string | null;
  ecosystem: DependencyEcosystem;
  sourceFile: string;
  section: string | null;
};

export type RegistryLookup = {
  ecosystem: 'pypi' | 'npm';
  package: string;
  found: boolean;
  latestVersion: string | null;
  deprecatedMessage: string | null;
  sourceUrl: string;
  error: string | null;
};

export type DependencyFindingStatus =
  'ok' | 'outdated' | 'deprecated' | 'unpinned' | 'not_found' | 'needs_manual_review';

export type DependencyFinding = {
  package: string;
  ecosystem: DependencyEcosystem;
  current: string | null;
  target: string | null;
  status: DependencyFindingStatus;
  reason: string;
  sourceFile: string;
  recommendedAction: 'keep' | 'upgrade' | 'replace' | 'pin' | 'manual_review';
};

export type DependencyAction = {
  package: string;
  action: 'upgrade' | 'replace' | 'pin';
  current: string | null;
  target: string;
  sourceFile: string;
  replacementPackage: string | null;
};

export type FileEdit = {
  path: string;
  search: string;
  replace: string;
};

export type AppliedChange = FileEdit & {
  action: DependencyAction['action'];
  package: string;
};

export type InstallReport = {
  success: boolean;
  packageManager: string;
  command: string;
  durationSeconds: number;
  logTail: string;
};

export type VerificationReport = {
  success: boolean;
  commands: Array<{ command: string; success: boolean; logTail: string }>;
  durationSeconds: number;
};

export type TraceEvent = {
  at: string;
  stage: DependencyRunStage;
  actor: 'orchestrator' | 'mcp' | 'adk-analyst' | 'crewai-updater' | 'a2a';
  message: string;
};

export type DependencyReport = {
  runId: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  dependenciesChecked: number;
  updated: DependencyAction[];
  deprecatedRemaining: DependencyFinding[];
  installSuccess: boolean;
  verificationSuccess: boolean;
  durationSeconds: number;
  estimatedLlmCostUsd: number;
};

export type DependencyRunState = {
  runId: string;
  repository: string;
  workspacePath: string;
  stage: DependencyRunStage;
  declaredDependencies: DeclaredDependency[];
  registryResults: RegistryLookup[];
  findings: DependencyFinding[];
  approvedActions: DependencyAction[];
  changes: AppliedChange[];
  installReport: InstallReport | null;
  verificationReport: VerificationReport | null;
  trace: TraceEvent[];
  finalStatus: DependencyRunStatus | null;
  createdAt: string;
  updatedAt: string;
};
