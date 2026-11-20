import type { DeclaredDependency, DependencyFinding, RegistryLookup } from './models.js';

function versionOf(constraint: string | null): string | null {
  if (!constraint) return null;
  return /(\d+\.\d+(?:\.\d+)?)/.exec(constraint)?.[1] ?? null;
}

function majorOf(version: string | null): number | null {
  const major = version ? Number(version.split('.')[0]) : NaN;
  return Number.isFinite(major) ? major : null;
}

export class DependencyAnalyst {
  run(declared: DeclaredDependency[], registry: RegistryLookup[]): DependencyFinding[] {
    return declared.map((dependency) => {
      const result = registry.find(
        (lookup) => lookup.ecosystem === dependency.ecosystem && lookup.package === dependency.name,
      );
      if (!result || !result.found || !result.latestVersion) {
        return {
          package: dependency.name,
          ecosystem: dependency.ecosystem,
          current: dependency.currentConstraint,
          target: null,
          status: 'not_found',
          reason: result?.error
            ? 'The registry could not be verified.'
            : 'The package was not found in the registry.',
          sourceFile: dependency.sourceFile,
          recommendedAction: 'manual_review',
        };
      }

      if (result.deprecatedMessage) {
        return {
          package: dependency.name,
          ecosystem: dependency.ecosystem,
          current: dependency.currentConstraint,
          target: null,
          status: 'deprecated',
          reason: result.deprecatedMessage,
          sourceFile: dependency.sourceFile,
          recommendedAction: 'manual_review',
        };
      }

      const current = versionOf(dependency.currentConstraint);
      if (!current) {
        return {
          package: dependency.name,
          ecosystem: dependency.ecosystem,
          current: dependency.currentConstraint,
          target: result.latestVersion,
          status: 'unpinned',
          reason: 'The declaration does not contain a verifiable version pin.',
          sourceFile: dependency.sourceFile,
          recommendedAction: 'pin',
        };
      }

      if (
        current === result.latestVersion ||
        dependency.currentConstraint?.includes(result.latestVersion)
      ) {
        return {
          package: dependency.name,
          ecosystem: dependency.ecosystem,
          current: dependency.currentConstraint,
          target: result.latestVersion,
          status: 'ok',
          reason: 'The declared constraint already includes the verified latest version.',
          sourceFile: dependency.sourceFile,
          recommendedAction: 'keep',
        };
      }

      if (majorOf(current) !== majorOf(result.latestVersion)) {
        return {
          package: dependency.name,
          ecosystem: dependency.ecosystem,
          current: dependency.currentConstraint,
          target: result.latestVersion,
          status: 'needs_manual_review',
          reason: 'The verified target crosses a major version and needs compatibility review.',
          sourceFile: dependency.sourceFile,
          recommendedAction: 'manual_review',
        };
      }

      return {
        package: dependency.name,
        ecosystem: dependency.ecosystem,
        current: dependency.currentConstraint,
        target: result.latestVersion,
        status: 'outdated',
        reason: 'A newer version was verified in the package registry.',
        sourceFile: dependency.sourceFile,
        recommendedAction: 'upgrade',
      };
    });
  }
}
