import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retrieveRepositoryContext } from '../src/services/repositoryContext.js';

test('retrieves relevant source across directories while excluding secrets and dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repository-context-'));
  try {
    await mkdir(join(root, 'backend'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'README.md'), 'Shared workspace for teams');
    await writeFile(
      join(root, 'backend', 'billing.ts'),
      'export function calculateInvoice() { return 42; }',
    );
    await writeFile(join(root, '.env'), 'BILLING_SECRET=do-not-send');
    await writeFile(join(root, 'node_modules', 'billing.js'), 'BILLING_SECRET=do-not-send');
    const result = await retrieveRepositoryContext(root, 'How does calculateInvoice work?');
    assert.equal(result.scannedFiles, 2);
    assert.equal(result.excerpts[0]?.path, 'backend/billing.ts');
    assert.ok(result.excerpts.some((entry) => entry.path === 'README.md'));
    assert.doesNotMatch(JSON.stringify(result), /do-not-send/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
