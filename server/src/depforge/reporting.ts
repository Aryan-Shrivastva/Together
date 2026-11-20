import type { DependencyReport, DependencyRunState } from './models.js';

export function reportForState(state: DependencyRunState): DependencyReport {
  const durationSeconds = Math.max(
    0,
    (Date.parse(state.updatedAt) - Date.parse(state.createdAt)) / 1_000,
  );
  const installSuccess = state.installReport?.success ?? false;
  const verificationSuccess = state.verificationReport?.success ?? false;
  const status =
    state.finalStatus === 'FAILED'
      ? 'FAILED'
      : installSuccess && verificationSuccess
        ? 'SUCCESS'
        : state.changes.length > 0
          ? 'PARTIAL'
          : 'FAILED';
  return {
    runId: state.runId,
    status,
    dependenciesChecked: state.declaredDependencies.length,
    updated: state.approvedActions,
    deprecatedRemaining: state.findings.filter(
      (finding) => finding.status === 'deprecated' || finding.status === 'needs_manual_review',
    ),
    installSuccess,
    verificationSuccess,
    durationSeconds,
    estimatedLlmCostUsd: 0,
  };
}

export function markdownReport(state: DependencyRunState): string {
  const report = reportForState(state);
  const rows = state.findings
    .map(
      (finding) =>
        `| ${finding.package} | ${finding.current ?? '—'} | ${finding.target ?? '—'} | ${finding.status} | ${finding.sourceFile} |`,
    )
    .join('\n');
  const install = state.installReport;
  const verification = state.verificationReport;
  return `# DepForge Dependency Report

- Run: \`${state.runId}\`
- Status: **${report.status}**
- Dependencies checked: **${report.dependenciesChecked}**

| Package | Before | After | Status | Source |
|---|---:|---:|---|---|
${rows || '| — | — | — | No declared dependencies | — |'}

## Installation

- Package manager: ${install?.packageManager ?? 'Not run'}
- Install result: ${install?.success ? 'Passed' : 'Not completed'}
- Duration: ${install ? `${install.durationSeconds.toFixed(1)} seconds` : '—'}

## Verification

- Result: ${verification?.success ? 'Passed' : 'Not completed or failed'}
${verification?.commands.map((entry) => `- \`${entry.command}\`: ${entry.success ? 'passed' : 'failed'}`).join('\n') ?? '- No verification commands were run.'}

## Remaining manual actions

${report.deprecatedRemaining.map((finding) => `- ${finding.package}: ${finding.reason}`).join('\n') || '- None.'}
`;
}
