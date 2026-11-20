import { randomUUID } from 'node:crypto';

import { prisma } from '../db/client.js';
import { HttpError } from '../errors/httpError.js';
import { runtimeService } from '../services/runtimeService.js';
import { workspaceService } from '../services/workspaceService.js';
import { DependencyAnalyst } from './analyst.js';
import { parseDependencies } from './manifestParser.js';
import type { DependencyAction, DependencyRunState, TraceEvent } from './models.js';
import { lookupDeclaredDependencies } from './registry.js';
import { markdownReport, reportForState } from './reporting.js';
import { listRunStates, loadRunState, saveReport, saveRunState } from './stateStore.js';
import { dependencyUpdater } from './updater.js';

function now(): string {
  return new Date().toISOString();
}

function trace(state: DependencyRunState, actor: TraceEvent['actor'], message: string): void {
  state.trace.push({ at: now(), stage: state.stage, actor, message });
}

function touch(state: DependencyRunState): void {
  state.updatedAt = now();
}

export class DependencyOrchestrator {
  private readonly analyst = new DependencyAnalyst();

  async createRun(workspaceId: string): Promise<DependencyRunState> {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { repoFullName: true, status: true },
    });
    if (!workspace || workspace.status !== 'READY') {
      throw new HttpError(409, 'The workspace must finish cloning before DepForge can inspect it.');
    }

    const state: DependencyRunState = {
      runId: randomUUID(),
      repository: workspace.repoFullName,
      workspacePath: workspaceService.getRoot(workspaceId),
      stage: 'DISCOVER',
      declaredDependencies: [],
      registryResults: [],
      findings: [],
      approvedActions: [],
      changes: [],
      installReport: null,
      verificationReport: null,
      trace: [],
      finalStatus: null,
      createdAt: now(),
      updatedAt: now(),
    };
    trace(state, 'orchestrator', 'Dependency-only run created.');
    await saveRunState(workspaceId, state);

    try {
      state.declaredDependencies = await parseDependencies(workspaceId);
      trace(
        state,
        'mcp',
        `parse_dependencies found ${state.declaredDependencies.length} declared packages.`,
      );
      state.stage = 'ANALYZE';
      touch(state);
      await saveRunState(workspaceId, state);

      state.registryResults = await lookupDeclaredDependencies(
        state.declaredDependencies.map(({ ecosystem, name }) => ({
          ecosystem: ecosystem === 'gradle' ? 'npm' : ecosystem,
          name,
        })),
      );
      trace(
        state,
        'mcp',
        `lookup_latest_version checked ${state.registryResults.length} registry records.`,
      );
      state.findings = this.analyst.run(state.declaredDependencies, state.registryResults);
      trace(
        state,
        'adk-analyst',
        'Structured dependency findings generated from registry evidence.',
      );
      state.stage = 'AWAIT_APPROVAL';
      touch(state);
      await saveRunState(workspaceId, state);
      await saveReport(workspaceId, state.runId, markdownReport(state));
      return state;
    } catch (error) {
      state.stage = 'REPORT';
      state.finalStatus = 'FAILED';
      trace(state, 'orchestrator', 'Discovery or analysis failed.');
      touch(state);
      await saveRunState(workspaceId, state);
      await saveReport(workspaceId, state.runId, markdownReport(state));
      throw error;
    }
  }

  async approveAndExecute(
    workspaceId: string,
    runId: string,
    actions: DependencyAction[],
  ): Promise<DependencyRunState> {
    const state = await this.getRun(workspaceId, runId);
    if (state.stage !== 'AWAIT_APPROVAL') {
      throw new HttpError(409, 'This dependency run is no longer awaiting approval.');
    }

    const approved = actions.map((action) => {
      const finding = state.findings.find(
        (candidate) =>
          candidate.package === action.package &&
          candidate.sourceFile === action.sourceFile &&
          candidate.target === action.target,
      );
      if (!finding || !finding.target || !['upgrade', 'pin'].includes(action.action)) {
        throw new HttpError(
          400,
          `The proposed action for ${action.package} is not approved by the audit.`,
        );
      }
      if (finding.recommendedAction !== action.action) {
        throw new HttpError(
          400,
          `The proposed action for ${action.package} does not match the finding.`,
        );
      }
      return { ...action, current: finding.current, replacementPackage: null };
    });
    state.approvedActions = approved;
    trace(state, 'orchestrator', `${approved.length} dependency actions approved by the user.`);
    touch(state);
    await saveRunState(workspaceId, state);

    try {
      state.stage = 'UPDATE';
      touch(state);
      await saveRunState(workspaceId, state);
      state.changes = await dependencyUpdater.apply(workspaceId, approved);
      trace(
        state,
        'crewai-updater',
        'Manifest-only edits applied after approval; source files were not eligible.',
      );

      state.stage = 'INSTALL';
      touch(state);
      await saveRunState(workspaceId, state);
      const installStartedAt = Date.now();
      const runtimeResult = await runtimeService.installDependencies(workspaceId, {
        lockfile: true,
      });
      state.installReport = {
        success: true,
        packageManager: runtimeResult.kind === 'node' ? 'npm' : 'pip',
        command:
          runtimeResult.kind === 'node'
            ? 'npm install --package-lock-only --ignore-scripts && npm ci --ignore-scripts'
            : 'pip install declared dependencies in the restricted runtime',
        durationSeconds: (Date.now() - installStartedAt) / 1_000,
        logTail: runtimeResult.message,
      };
      trace(state, 'orchestrator', 'Dependencies installed in the restricted workspace runtime.');

      state.stage = 'VERIFY';
      touch(state);
      await saveRunState(workspaceId, state);
      state.verificationReport = await runtimeService.verifyWorkspace(workspaceId);
      trace(state, 'orchestrator', 'Build/test/type-check verification completed.');

      state.stage = 'REPORT';
      state.finalStatus = state.verificationReport.success ? 'SUCCESS' : 'PARTIAL';
      touch(state);
      await saveRunState(workspaceId, state);
      await saveReport(workspaceId, state.runId, markdownReport(state));
      state.stage = 'DONE';
      touch(state);
      await saveRunState(workspaceId, state);
      return state;
    } catch (error) {
      state.finalStatus = 'FAILED';
      state.stage = 'REPORT';
      state.installReport ??= {
        success: false,
        packageManager: 'unknown',
        command: 'Dependency installation failed before completion.',
        durationSeconds: 0,
        logTail: 'The installer or verifier reported a failure.',
      };
      trace(state, 'orchestrator', 'The approved dependency workflow failed and was recorded.');
      touch(state);
      await saveRunState(workspaceId, state);
      await saveReport(workspaceId, state.runId, markdownReport(state));
      if (error instanceof HttpError) return state;
      return state;
    }
  }

  async reject(workspaceId: string, runId: string): Promise<DependencyRunState> {
    const state = await this.getRun(workspaceId, runId);
    if (state.stage !== 'AWAIT_APPROVAL') {
      throw new HttpError(409, 'This dependency run is no longer awaiting approval.');
    }
    state.stage = 'DONE';
    state.finalStatus = 'ABORTED';
    trace(state, 'orchestrator', 'All proposed changes were rejected by the user.');
    touch(state);
    await saveRunState(workspaceId, state);
    await saveReport(workspaceId, state.runId, markdownReport(state));
    return state;
  }

  async getRun(workspaceId: string, runId: string): Promise<DependencyRunState> {
    try {
      return await loadRunState(workspaceId, runId);
    } catch {
      throw new HttpError(404, 'The dependency run was not found.');
    }
  }

  async listRuns(workspaceId: string): Promise<DependencyRunState[]> {
    return listRunStates(workspaceId);
  }

  report(workspaceId: string, state: DependencyRunState) {
    void workspaceId;
    return reportForState(state);
  }
}

export const dependencyOrchestrator = new DependencyOrchestrator();
