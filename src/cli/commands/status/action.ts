import { ConfigIO } from '../../../lib';
import type { AgentCoreProjectSpec, AwsDeploymentTargets, DeployedState } from '../../../schema';
import { getAgentRuntimeStatus, resolveTarget } from '../../aws';
import { getErrorMessage } from '../../errors';

export interface StatusContext {
  project: AgentCoreProjectSpec;
  deployedState: DeployedState;
  awsTargets: AwsDeploymentTargets;
}

/**
 * Loads configuration required for status check
 */
export async function loadStatusConfig(configIO: ConfigIO = new ConfigIO()): Promise<StatusContext> {
  return {
    project: await configIO.readProjectSpec(),
    deployedState: await configIO.readDeployedState(),
    awsTargets: await configIO.readAWSDeploymentTargets(),
  };
}

export interface StatusOptions {
  agentName?: string;
  targetName?: string;
  agentRuntimeId?: string;
}

export interface StatusResult {
  success: boolean;
  agentName?: string;
  targetName?: string;
  isDeployed?: boolean;
  runtimeId?: string;
  runtimeStatus?: string;
  error?: string;
}

export interface StatusEntry {
  agentName: string;
  isDeployed: boolean;
  runtimeId?: string;
  runtimeStatus?: string;
  error?: string;
}

export interface StatusSummaryResult {
  success: boolean;
  targetName?: string;
  entries?: StatusEntry[];
  error?: string;
}

/**
 * Main status handler
 */
export async function handleStatus(context: StatusContext, options: StatusOptions = {}): Promise<StatusResult> {
  const { project, deployedState, awsTargets } = context;

  // Resolve target
  const targetNames = options.agentRuntimeId
    ? awsTargets.map(target => target.name)
    : Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    return {
      success: false,
      error: options.agentRuntimeId
        ? 'No deployment targets found. Run `agentcore create` first.'
        : 'No deployed targets found. Run `agentcore deploy` first.',
    };
  }
  const selectedTargetName = options.targetName ?? targetNames[0]!;

  if (options.targetName && !targetNames.includes(options.targetName)) {
    return { success: false, error: `Target '${options.targetName}' not found. Available: ${targetNames.join(', ')}` };
  }

  const targetState = selectedTargetName ? deployedState.targets[selectedTargetName] : undefined;
  const savedTargetConfig = awsTargets.find(target => target.name === selectedTargetName);

  if (!savedTargetConfig) {
    return { success: false, error: `Target config '${selectedTargetName}' not found in aws-targets` };
  }

  // Apply environment variable overrides (AWS_REGION)
  const targetConfig = resolveTarget(savedTargetConfig);

  if (options.agentRuntimeId) {
    try {
      const runtimeStatus = await getAgentRuntimeStatus({
        region: targetConfig.region,
        runtimeId: options.agentRuntimeId,
      });

      return {
        success: true,
        targetName: selectedTargetName,
        runtimeId: runtimeStatus.runtimeId,
        runtimeStatus: runtimeStatus.status,
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  }

  if (project.agents.length === 0) {
    return { success: false, error: 'No agents defined in configuration' };
  }

  // Resolve agent
  const agentNames = project.agents.map(a => a.name);
  const agentSpec = options.agentName ? project.agents.find(a => a.name === options.agentName) : project.agents[0];

  if (options.agentName && !agentSpec) {
    return { success: false, error: `Agent '${options.agentName}' not found. Available: ${agentNames.join(', ')}` };
  }

  if (!agentSpec) {
    return { success: false, error: 'No agents defined in configuration' };
  }

  // Get the deployed state for this specific agent
  const agentState = targetState?.resources?.agents?.[agentSpec.name];

  if (!agentState) {
    return {
      success: true,
      agentName: agentSpec.name,
      targetName: selectedTargetName,
      isDeployed: false,
    };
  }

  try {
    const runtimeStatus = await getAgentRuntimeStatus({
      region: targetConfig.region,
      runtimeId: agentState.runtimeId,
    });

    return {
      success: true,
      agentName: agentSpec.name,
      targetName: selectedTargetName,
      isDeployed: true,
      runtimeId: runtimeStatus.runtimeId,
      runtimeStatus: runtimeStatus.status,
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * Status handler for all agents in a target.
 */
export async function handleStatusAll(
  context: StatusContext,
  options: StatusOptions = {}
): Promise<StatusSummaryResult> {
  const { project, deployedState, awsTargets } = context;

  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    return { success: false, error: 'No deployed targets found. Run `agentcore deploy` first.' };
  }

  const selectedTargetName = options.targetName ?? targetNames[0]!;

  if (options.targetName && !targetNames.includes(options.targetName)) {
    return { success: false, error: `Target '${options.targetName}' not found. Available: ${targetNames.join(', ')}` };
  }

  const targetState = deployedState.targets[selectedTargetName];
  const savedTargetConfig = awsTargets.find(target => target.name === selectedTargetName);

  if (!savedTargetConfig) {
    return { success: false, error: `Target config '${selectedTargetName}' not found in aws-targets` };
  }

  // Apply environment variable overrides (AWS_REGION)
  const targetConfig = resolveTarget(savedTargetConfig);

  if (project.agents.length === 0) {
    return { success: false, error: 'No agents defined in configuration' };
  }

  const entries = await Promise.all(
    project.agents.map(async agentSpec => {
      const agentState = targetState?.resources?.agents?.[agentSpec.name];

      if (!agentState) {
        return {
          agentName: agentSpec.name,
          isDeployed: false,
        };
      }

      try {
        const runtimeStatus = await getAgentRuntimeStatus({
          region: targetConfig.region,
          runtimeId: agentState.runtimeId,
        });

        return {
          agentName: agentSpec.name,
          isDeployed: true,
          runtimeId: runtimeStatus.runtimeId,
          runtimeStatus: runtimeStatus.status,
        };
      } catch (error) {
        return {
          agentName: agentSpec.name,
          isDeployed: true,
          runtimeId: agentState.runtimeId,
          error: getErrorMessage(error),
        };
      }
    })
  );

  return {
    success: true,
    targetName: selectedTargetName,
    entries,
  };
}
