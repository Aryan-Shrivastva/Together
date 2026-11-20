import { readFile, writeFile } from 'node:fs/promises';

import { HttpError } from '../errors/httpError.js';
import { workspaceService } from '../services/workspaceService.js';
import { validateManifest } from './manifestParser.js';
import type { AppliedChange, DependencyAction, FileEdit } from './models.js';

const ALLOWED_MANIFESTS = new Set([
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'build.gradle',
  'build.gradle.kts',
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function npmEdit(content: string, action: DependencyAction): FileEdit {
  const pattern = new RegExp(
    `(["'])${escapeRegExp(action.package)}\\1(\\s*:\\s*)(["'])${escapeRegExp(action.current ?? '')}\\3`,
  );
  const match = pattern.exec(content);
  if (!match)
    throw new HttpError(409, `The approved ${action.package} entry changed before update.`);
  const search = match[0];
  const replace = `${match[1]}${action.package}${match[1]}${match[2]}${match[3]}${action.target}${match[3]}`;
  return { path: 'package.json', search, replace };
}

function requirementsEdit(content: string, action: DependencyAction): FileEdit {
  const lines = content.split(/\r?\n/);
  const namePattern = new RegExp(
    `^(\\s*${escapeRegExp(action.package)}(?:\\[[^\\]]+\\])?)(.*)$`,
    'i',
  );
  const index = lines.findIndex((line) => {
    const match = namePattern.exec(line.trimEnd());
    return Boolean(match && (!action.current || match[2]?.includes(action.current)));
  });
  if (index < 0)
    throw new HttpError(409, `The approved ${action.package} entry changed before update.`);
  const original = lines[index] ?? '';
  const match = namePattern.exec(original);
  if (!match)
    throw new HttpError(409, `The approved ${action.package} entry changed before update.`);
  const trailingComment = /(;\s*#.*|\s+#.*)$/.exec(match[2] ?? '')?.[1] ?? '';
  const replacement = `${match[1]}==${action.target}${trailingComment}`;
  lines[index] = replacement;
  return { path: 'requirements.txt', search: original, replace: replacement };
}

function pyprojectEdit(content: string, action: DependencyAction): FileEdit {
  const valuePattern = action.current ? escapeRegExp(action.current) : `[^"']*`;
  const pattern = new RegExp(`(["'])${escapeRegExp(action.package)}${valuePattern}\\1`);
  const match = pattern.exec(content);
  if (!match)
    throw new HttpError(409, `The approved ${action.package} entry changed before update.`);
  const search = match[0];
  const quote = match[1];
  return {
    path: 'pyproject.toml',
    search,
    replace: `${quote}${action.package}==${action.target}${quote}`,
  };
}

export class DependencyUpdater {
  buildEdits(actions: DependencyAction[], contents: Map<string, string>): FileEdit[] {
    return actions.map((action) => {
      if (!ALLOWED_MANIFESTS.has(action.sourceFile)) {
        throw new HttpError(400, 'Dependency updates are limited to approved manifest files.');
      }
      const content = contents.get(action.sourceFile);
      if (content === undefined)
        throw new HttpError(409, `${action.sourceFile} is no longer available.`);
      if (action.sourceFile === 'package.json') return npmEdit(content, action);
      if (action.sourceFile === 'requirements.txt') return requirementsEdit(content, action);
      if (action.sourceFile === 'pyproject.toml') return pyprojectEdit(content, action);
      throw new HttpError(400, `${action.sourceFile} is not supported by this updater yet.`);
    });
  }

  async apply(workspaceId: string, actions: DependencyAction[]): Promise<AppliedChange[]> {
    const uniquePaths = [...new Set(actions.map((action) => action.sourceFile))];
    const originals = new Map<string, string>();
    for (const path of uniquePaths) {
      const absolutePath = await workspaceService.resolveFilePath(workspaceId, path);
      originals.set(path, await readFile(absolutePath, 'utf8'));
    }
    const edits = this.buildEdits(actions, originals);
    const updatedContents = new Map(originals);
    for (const edit of edits) {
      const content = updatedContents.get(edit.path);
      if (content === undefined || content.indexOf(edit.search) === -1) {
        throw new HttpError(409, `The approved ${edit.path} entry changed before update.`);
      }
      updatedContents.set(edit.path, content.replace(edit.search, edit.replace));
    }
    for (const [path, content] of updatedContents) {
      const validation = validateManifest(path, content);
      if (!validation.valid)
        throw new HttpError(422, validation.error ?? 'The manifest is invalid.');
    }

    try {
      for (const [path, content] of updatedContents) {
        await writeFile(await workspaceService.resolveFilePath(workspaceId, path), content, 'utf8');
      }
    } catch (error) {
      for (const [path, content] of originals) {
        await writeFile(await workspaceService.resolveFilePath(workspaceId, path), content, 'utf8');
      }
      throw error;
    }

    return edits.map((edit, index) => ({
      ...edit,
      action: actions[index]?.action ?? 'upgrade',
      package: actions[index]?.package ?? 'unknown',
    }));
  }
}

export const dependencyUpdater = new DependencyUpdater();
