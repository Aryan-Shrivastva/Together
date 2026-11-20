import type { RegistryLookup } from './models.js';

const LOOKUP_TIMEOUT_MS = 8_000;

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Registry responded with ${response.status}.`);
  return response.json();
}

export async function lookupLatestVersion(
  ecosystem: 'pypi' | 'npm',
  packageName: string,
): Promise<RegistryLookup> {
  const sourceUrl =
    ecosystem === 'npm'
      ? `https://www.npmjs.com/package/${encodeURIComponent(packageName)}`
      : `https://pypi.org/project/${encodeURIComponent(packageName)}/`;
  try {
    if (ecosystem === 'npm') {
      const data = (await getJson(
        `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
      )) as {
        'dist-tags'?: { latest?: string };
        versions?: Record<string, { deprecated?: string }>;
      };
      const latestVersion = data['dist-tags']?.latest ?? null;
      return {
        ecosystem,
        package: packageName,
        found: Boolean(latestVersion),
        latestVersion,
        deprecatedMessage: latestVersion
          ? (data.versions?.[latestVersion]?.deprecated ?? null)
          : null,
        sourceUrl,
        error: null,
      };
    }

    const data = (await getJson(
      `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`,
    )) as { info?: { version?: string; yanked?: boolean; summary?: string } };
    const latestVersion = data.info?.version ?? null;
    return {
      ecosystem,
      package: packageName,
      found: Boolean(latestVersion),
      latestVersion,
      deprecatedMessage: data.info?.yanked ? (data.info.summary ?? 'The package is yanked.') : null,
      sourceUrl,
      error: null,
    };
  } catch (error) {
    return {
      ecosystem,
      package: packageName,
      found: false,
      latestVersion: null,
      deprecatedMessage: null,
      sourceUrl,
      error: error instanceof Error ? error.message : 'Registry lookup failed.',
    };
  }
}

export async function lookupDeclaredDependencies(
  dependencies: Array<{ ecosystem: 'pypi' | 'npm'; name: string }>,
): Promise<RegistryLookup[]> {
  const unique = new Map(
    dependencies.map((dependency) => [`${dependency.ecosystem}:${dependency.name}`, dependency]),
  );
  return Promise.all(
    [...unique.values()]
      .slice(0, 50)
      .map((dependency) => lookupLatestVersion(dependency.ecosystem, dependency.name)),
  );
}
