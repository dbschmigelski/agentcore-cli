import type { AwsDeploymentTarget } from '../../schema';
import { AgentCoreRegionSchema } from '../../schema';

/**
 * Resolve a deployment target with environment variable overrides.
 * AWS_REGION/AWS_DEFAULT_REGION override the saved target region.
 * This follows standard AWS SDK precedence where env vars take priority.
 */
export function resolveTarget(savedTarget: AwsDeploymentTarget): AwsDeploymentTarget {
  const envRegion = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

  if (envRegion && AgentCoreRegionSchema.safeParse(envRegion).success) {
    return {
      ...savedTarget,
      region: envRegion as AwsDeploymentTarget['region'],
    };
  }

  return savedTarget;
}
