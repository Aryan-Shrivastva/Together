import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { workspaceService } from '../services/workspaceService.js';
import type { DeclaredDependency, DependencyEcosystem } from './models.js';

type Manifest = { path: string; content: string };

function parseJsonObjects(content: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? [parsed as Record<string, unknown>]
      : [];
  } catch {
    // Some repositories may contain two pasted manifest objects. Keep discovery read-only and
    // recover each complete object so the preview can still explain what it found.
  }

  const objects: Array<Record<string, unknown>> = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (start === -1) {
      if (character === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(content.slice(start, index + 1)) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            objects.push(parsed as Record<string, unknown>);
          }
        } catch {
          // Ignore an incomplete object and continue looking for a later complete one.
        }
        start = -1;
      }
    }
  }

  return objects;
}

async function readOptional(workspaceId: string, path: string): Promise<Manifest | null> {
  try {
    const absolutePath = await workspaceService.resolveFilePath(workspaceId, path);
    return { path, content: await readFile(absolutePath, 'utf8') };
  } catch {
    return null;
  }
}

function addNodeDependencies(
  result: DeclaredDependency[],
  content: string,
  sourceFile: string,
): void {
  for (const manifest of parseJsonObjects(content)) {
    for (const section of ['dependencies', 'devDependencies'] as const) {
      const entries = manifest[section];
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
      for (const [name, requested] of Object.entries(entries)) {
        result.push({
          name,
          currentConstraint: typeof requested === 'string' ? requested : null,
          ecosystem: 'npm',
          sourceFile,
          section,
        });
      }
    }
  }
}

function workspaceManifestPaths(content: string): string[] {
  try {
    const manifest = JSON.parse(content) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const entries = Array.isArray(manifest.workspaces)
      ? manifest.workspaces
      : (manifest.workspaces?.packages ?? []);
    return entries
      .filter(
        (entry) =>
          typeof entry === 'string' &&
          entry.length > 0 &&
          !entry.includes('*') &&
          !entry.includes('..') &&
          !entry.includes('\\') &&
          !entry.startsWith('/'),
      )
      .map((entry) => `${entry}/package.json`);
  } catch {
    return [];
  }
}

function addRequirements(result: DeclaredDependency[], content: string, sourceFile: string): void {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const withoutComment = line.split(';', 1)[0]?.trim() ?? line;
    const name = withoutComment.split(/[<>=!~\s]/, 1)[0]?.split('[', 1)[0];
    if (!name) continue;
    result.push({
      name,
      currentConstraint: withoutComment.slice(name.length).trim() || null,
      ecosystem: 'pypi',
      sourceFile,
      section: null,
    });
  }
}

function addPyprojectDependencies(result: DeclaredDependency[], content: string): void {
  const dependencyBlock = /dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(content)?.[1] ?? '';
  for (const match of dependencyBlock.matchAll(/["']([^"']+)["']/g)) {
    const requested = match[1]?.trim();
    if (!requested) continue;
    const name = requested.split(/[<>=!~\s]/, 1)[0]?.split('[', 1)[0];
    if (!name) continue;
    result.push({
      name,
      currentConstraint: requested.slice(name.length).trim() || null,
      ecosystem: 'pypi',
      sourceFile: 'pyproject.toml',
      section: 'project.dependencies',
    });
  }
}

export async function parseDependencies(workspaceId: string): Promise<DeclaredDependency[]> {
  const rootManifests = await Promise.all(
    ['package.json', 'requirements.txt', 'pyproject.toml'].map((path) =>
      readOptional(workspaceId, path),
    ),
  );
  const workspacePaths = workspaceManifestPaths(
    rootManifests.find((manifest) => manifest?.path === 'package.json')?.content ?? '',
  );
  const workspaceManifests = await Promise.all(
    workspacePaths.map((path) => readOptional(workspaceId, path)),
  );
  const manifests = [...rootManifests, ...workspaceManifests];
  const dependencies: DeclaredDependency[] = [];
  manifests.forEach((manifest) => {
    if (!manifest) return;
    if (manifest.path === 'package.json' || manifest.path.endsWith('/package.json'))
      addNodeDependencies(dependencies, manifest.content, manifest.path);
    if (manifest.path === 'requirements.txt') {
      addRequirements(dependencies, manifest.content, manifest.path);
    }
    if (manifest.path === 'pyproject.toml')
      addPyprojectDependencies(dependencies, manifest.content);
  });
  return Array.from(
    new Map(
      dependencies.map((dependency) => [
        `${dependency.sourceFile}:${dependency.section}:${dependency.name}:${dependency.currentConstraint}`,
        dependency,
      ]),
    ).values(),
  ).sort((left, right) =>
    `${left.sourceFile}:${left.name}`.localeCompare(`${right.sourceFile}:${right.name}`),
  );
}

export function ecosystemForManifest(path: string): DependencyEcosystem | null {
  if (path === 'package.json' || path.endsWith('/package.json')) return 'npm';
  if (path === 'requirements.txt' || path === 'pyproject.toml') return 'pypi';
  return null;
}

export async function readManifest(workspaceId: string, path: string): Promise<string> {
  const absolutePath = await workspaceService.resolveFilePath(workspaceId, path);
  return readFile(resolve(absolutePath), 'utf8');
}

export function validateManifest(
  path: string,
  content: string,
): { valid: boolean; error?: string } {
  if (path === 'package.json') {
    try {
      JSON.parse(content);
    } catch {
      return { valid: false, error: 'package.json is not valid JSON.' };
    }
  }
  if (path === 'requirements.txt' && content.includes('\0')) {
    return { valid: false, error: 'requirements.txt contains invalid binary data.' };
  }
  if (path === 'pyproject.toml') {
    const quoteCount = (content.match(/"/g) ?? []).length;
    if (quoteCount % 2 !== 0)
      return { valid: false, error: 'pyproject.toml has unmatched quotes.' };
  }
  return { valid: true };
}
