import { readdir, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// A bounded, local lexical index: source content stays on the server until selected.
const excludedDirectories = new Set([
  '.git',
  'node_modules',
  '.together',
  'dist',
  'build',
  'coverage',
  'vendor',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
]);
const excludedName =
  /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore|crt|cer)|(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)|.*(?:secret|credential).*)$/i;
const textName =
  /(?:\.(?:md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|java|kt|c|h|cpp|cs|rb|php|html|css|scss|sql|prisma|yml|yaml|toml|sh|graphql|vue|svelte)|^(?:README|Dockerfile|Makefile))$/i;
const stop = new Set(
  'what is the a an and or of in to for this that how does do are on it about project repository code explain me tell'.split(
    ' ',
  ),
);
type Chunk = { path: string; startLine: number; content: string; score: number };

export async function retrieveRepositoryContext(root: string, question: string) {
  const terms = [
    ...new Set(
      (question.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []).filter((term) => !stop.has(term)),
    ),
  ].slice(0, 30);
  const chunks: Chunk[] = [];
  let scannedFiles = 0,
    skippedFiles = 0,
    visitedEntries = 0,
    scannedBytes = 0;
  let truncated = false;
  async function visit(dir: string, prefix = ''): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skippedFiles++;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visitedEntries > 12000) {
        truncated = true;
        return;
      }
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        skippedFiles++;
        continue;
      }
      if (entry.isDirectory()) {
        if (excludedDirectories.has(entry.name) || entry.name.startsWith('.')) {
          skippedFiles++;
          continue;
        }
        await visit(join(dir, entry.name), path);
        if (truncated) return;
        continue;
      }
      if (
        !entry.isFile() ||
        excludedName.test(entry.name) ||
        entry.name.startsWith('.') ||
        !textName.test(entry.name)
      ) {
        skippedFiles++;
        continue;
      }
      try {
        const absolute = join(dir, entry.name);
        const stat = await lstat(absolute);
        if (!stat.isFile() || stat.size > 150_000) {
          skippedFiles++;
          continue;
        }
        if (scannedBytes + stat.size > 20_000_000) {
          truncated = true;
          return;
        }
        const buffer = await readFile(absolute);
        if (buffer.includes(0)) {
          skippedFiles++;
          continue;
        }
        scannedBytes += buffer.length;
        scannedFiles++;
        const lines = buffer.toString('utf8').split('\n');
        for (let start = 0; start < lines.length; start += 50) {
          const content = lines
            .slice(start, start + 50)
            .join('\n')
            .slice(0, 6000);
          const haystack = `${path}\n${content}`.toLowerCase();
          const relevance = terms.reduce(
            (score, term) =>
              score +
              (new RegExp(`(^|[^a-z0-9_])${term}([^a-z0-9_]|$)`).test(haystack) ? 6 : 0) +
              (path.toLowerCase().includes(term) ? 2 : 0),
            0,
          );
          const overview = /(^|\/)readme(?:\.[^/]*)?$/i.test(path)
            ? 4
            : /(^|\/)(package\.json|pyproject\.toml|cargo\.toml)$/i.test(path)
              ? 2
              : 0;
          chunks.push({ path, startLine: start + 1, content, score: relevance + overview });
        }
      } catch {
        skippedFiles++;
      }
    }
  }
  await visit(root);
  chunks.sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine,
  );
  // Limit both the per-file contribution and total data sent to the model.
  const selected: Omit<Chunk, 'score'>[] = [];
  const perFile = new Map<string, number>();
  let remaining = 24000;
  for (const chunk of chunks) {
    if (selected.length >= 10 || remaining < 500) break;
    if ((perFile.get(chunk.path) ?? 0) >= 2 || (terms.length && chunk.score === 0)) continue;
    const content = chunk.content.slice(0, Math.min(remaining, 3500));
    selected.push({ path: chunk.path, startLine: chunk.startLine, content });
    perFile.set(chunk.path, (perFile.get(chunk.path) ?? 0) + 1);
    remaining -= content.length;
  }
  return { scannedFiles, skippedFiles, truncated, excerpts: selected };
}
