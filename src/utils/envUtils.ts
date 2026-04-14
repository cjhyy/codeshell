/**
 * Environment variable helpers — ported from CC's utils/envUtils with full implementations.
 */

import { homedir } from 'os'
import { join } from 'path'

// Memoize cache for getClaudeConfigHomeDir
let _configHomeDirCache: string | null = null;
let _configHomeDirCacheKey: string | undefined = undefined;

/**
 * Returns the Claude/Code Shell config home directory.
 * Defaults to ~/.claude, overridable via CLAUDE_CONFIG_DIR env var.
 * Memoized — keyed off CLAUDE_CONFIG_DIR so tests that change the env var get a fresh value.
 */
export function getClaudeConfigHomeDir(): string {
  const envKey = process.env.CLAUDE_CONFIG_DIR;
  if (_configHomeDirCache !== null && _configHomeDirCacheKey === envKey) {
    return _configHomeDirCache;
  }
  _configHomeDirCacheKey = envKey;
  _configHomeDirCache = (envKey ?? join(homedir(), '.claude')).normalize('NFC');
  return _configHomeDirCache;
}

export function getTeamsDir(): string {
  return join(getClaudeConfigHomeDir(), 'teams');
}

export function isEnvTruthy(val: string | boolean | undefined): boolean {
  if (!val) return false;
  if (typeof val === 'boolean') return val;
  const normalizedValue = val.toLowerCase().trim();
  return ['1', 'true', 'yes', 'on'].includes(normalizedValue);
}

export function isEnvDefinedFalsy(
  envVar: string | boolean | undefined,
): boolean {
  if (envVar === undefined) return false
  if (typeof envVar === 'boolean') return !envVar
  if (!envVar) return false
  const normalizedValue = envVar.toLowerCase().trim()
  return ['0', 'false', 'no', 'off'].includes(normalizedValue)
}

/**
 * Check if NODE_OPTIONS contains a specific flag.
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS;
  if (!nodeOptions) return false;
  return nodeOptions.split(/\s+/).includes(flag);
}

/**
 * --bare / CLAUDE_CODE_SIMPLE — skip hooks, LSP, plugin sync, skill dir-walk,
 * attribution, background prefetches, and ALL keychain/credential reads.
 */
export function isBareMode(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE) ||
    process.argv.includes('--bare')
  );
}

/**
 * Parses an array of environment variable strings into a key-value object.
 * @param rawEnvArgs Array of strings in KEY=VALUE format
 */
export function parseEnvVars(
  rawEnvArgs: string[] | undefined,
): Record<string, string> {
  const parsedEnv: Record<string, string> = {};
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split('=');
      if (!key || valueParts.length === 0) {
        throw new Error(
          `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
        );
      }
      parsedEnv[key] = valueParts.join('=');
    }
  }
  return parsedEnv;
}

/**
 * Get the AWS region with fallback to default.
 */
export function getAWSRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
}

/**
 * Get the default Vertex AI region.
 */
export function getDefaultVertexRegion(): string {
  return process.env.CLOUD_ML_REGION || 'us-east5';
}

/**
 * Check if bash commands should maintain project working directory.
 */
export function shouldMaintainProjectWorkingDir(): boolean {
  return isEnvTruthy(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR);
}

/**
 * Check if running on Homespace (ant-internal cloud environment).
 */
export function isRunningOnHomespace(): boolean {
  return (
    process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.COO_RUNNING_ON_HOMESPACE)
  );
}

/**
 * Model prefix → env var for Vertex region overrides.
 */
const VERTEX_REGION_OVERRIDES: ReadonlyArray<[string, string]> = [
  ['claude-haiku-4-5', 'VERTEX_REGION_CLAUDE_HAIKU_4_5'],
  ['claude-3-5-haiku', 'VERTEX_REGION_CLAUDE_3_5_HAIKU'],
  ['claude-3-5-sonnet', 'VERTEX_REGION_CLAUDE_3_5_SONNET'],
  ['claude-3-7-sonnet', 'VERTEX_REGION_CLAUDE_3_7_SONNET'],
  ['claude-opus-4-1', 'VERTEX_REGION_CLAUDE_4_1_OPUS'],
  ['claude-opus-4', 'VERTEX_REGION_CLAUDE_4_0_OPUS'],
  ['claude-sonnet-4-6', 'VERTEX_REGION_CLAUDE_4_6_SONNET'],
  ['claude-sonnet-4-5', 'VERTEX_REGION_CLAUDE_4_5_SONNET'],
  ['claude-sonnet-4', 'VERTEX_REGION_CLAUDE_4_0_SONNET'],
];

/**
 * Get the Vertex AI region for a specific model.
 */
export function getVertexRegionForModel(
  model: string | undefined,
): string | undefined {
  if (model) {
    const match = VERTEX_REGION_OVERRIDES.find(([prefix]) =>
      model.startsWith(prefix),
    );
    if (match) {
      return process.env[match[1]] || getDefaultVertexRegion();
    }
  }
  return getDefaultVertexRegion();
}

/**
 * Stub: Check if running inside a protected namespace.
 * Always returns false in Code Shell (Anthropic-internal feature).
 */
export function isInProtectedNamespace(): boolean {
  return false;
}
