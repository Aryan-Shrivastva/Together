import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { workspaceService } from '../services/workspaceService.js';
import type { DependencyRunState } from './models.js';

function runsDirectory(workspaceId: string): string {
  return join(workspaceService.getRoot(workspaceId), '.together', 'depforge', 'runs');
}

function runDirectory(workspaceId: string, runId: string): string {
  if (!/^[a-f0-9-]{20,64}$/i.test(runId)) throw new Error('Invalid dependency run id.');
  return join(runsDirectory(workspaceId), runId);
}

async function ensureLocalRunStateIgnored(workspaceId: string): Promise<void> {
  const excludePath = join(workspaceService.getRoot(workspaceId), '.git', 'info', 'exclude');
  try {
    await mkdir(dirname(excludePath), { recursive: true });
    let content = '';
    try {
      content = await readFile(excludePath, 'utf8');
    } catch {
      // A fresh clone may not have a local exclude file yet.
    }
    const entries = content.split(/\r?\n/).map((entry) => entry.trim());
    if (entries.includes('.together/') || entries.includes('.together')) return;
    await writeFile(
      excludePath,
      `${content.trimEnd()}${content.trimEnd() ? '\n' : ''}.together/\n`,
      'utf8',
    );
  } catch {
    // Git exclusion is best-effort; run state must still be persisted.
  }
}

export async function saveRunState(workspaceId: string, state: DependencyRunState): Promise<void> {
  const directory = runDirectory(workspaceId, state.runId);
  await ensureLocalRunStateIgnored(workspaceId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

export async function loadRunState(
  workspaceId: string,
  runId: string,
): Promise<DependencyRunState> {
  const content = await readFile(join(runDirectory(workspaceId, runId), 'state.json'), 'utf8');
  return JSON.parse(content) as DependencyRunState;
}

export async function listRunStates(workspaceId: string): Promise<DependencyRunState[]> {
  try {
    const entries = await readdir(runsDirectory(workspaceId), { withFileTypes: true });
    const states = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && /^[a-f0-9-]{20,64}$/i.test(entry.name))
        .map(async (entry) => {
          try {
            return await loadRunState(workspaceId, entry.name);
          } catch {
            return null;
          }
        }),
    );
    return states
      .filter((state): state is DependencyRunState => state !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch {
    return [];
  }
}

export async function saveReport(
  workspaceId: string,
  runId: string,
  markdown: string,
): Promise<void> {
  await writeFile(join(runDirectory(workspaceId, runId), 'report.md'), markdown, 'utf8');
}
