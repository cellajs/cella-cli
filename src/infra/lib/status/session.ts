import { dbExposureConfigured } from '../db-public-endpoint';
import { readAppliedEngine } from '../deploy/applied-engine';
import { readLiveRecord } from '../deploy/live-record';
import { findMainJob } from '../deploy/main-job';
import type { EngineConfig } from '../engine-config';
import { deriveInfra, hasDomain as hasDeployDomain } from '../naming';
import { type KeyPair, resolveOperatorIdentity } from '../scaleway/operator-identity';
import { projectAccessKey } from '../scaleway/s3-client';
import { listJobRuns, readJobDefinition } from '../scaleway/serverless-jobs';
import type { StackState } from '../stack/bootstrap-stack-state';
import { leaseLive, lockKey, makeControlClient, peekLock, stateBucket } from '../stack/control-store';
import { buildStatusReport } from './registry';
import type { ProbeSession, ScalewayFacts, StatusReport } from './types';

/** Everything the report needs about the target stack, from the menu. */
export interface StatusContext {
  mode: string;
  appConfig: EngineConfig;
  stackState: StackState;
  stackYaml?: string;
  projectId?: string;
  /** The operator key, when the run holds it: the machines are listed with it. */
  operatorKey?: KeyPair;
}

/** An S3-style NoSuchBucket, distinct from a refused read (bucket exists). */
function isNoSuchBucket(err: unknown): boolean {
  const e = err as { name?: string };
  return e?.name === 'NoSuchBucket';
}

/**
 * Build the probe session the providers draw on: resolved stack context, the key to probe with (the observer key, else the key the process
 * was started with), and one memoized best-effort read of the state bucket's presence, the control records (the lease, the live record, the
 * rotations) and the main job's definition with its newest runs, shared by the providers.
 */
export function buildSession(ctx: StatusContext): ProbeSession {
  const identity = resolveOperatorIdentity();
  const aws =
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? { accessKey: process.env.AWS_ACCESS_KEY_ID, secretKey: process.env.AWS_SECRET_ACCESS_KEY }
      : undefined;
  const key = identity.observer ?? identity.ambient ?? aws;
  const projectId = ctx.projectId ?? process.env.SCW_DEFAULT_PROJECT_ID;
  const accessKey = key?.accessKey;
  const secretKey = key?.secretKey;
  const scalewayKeyAvailable = Boolean(accessKey && secretKey);
  let hasDomain = false;
  try {
    hasDomain = deriveInfra(ctx.appConfig).hasDomain;
  } catch {
    hasDomain = hasDeployDomain(ctx.appConfig);
  }

  let memo: Promise<ScalewayFacts> | undefined;
  const scalewayFacts = (): Promise<ScalewayFacts> => {
    memo ??= (async () => {
      const out: ScalewayFacts = {};
      if (!scalewayKeyAvailable || !accessKey || !secretKey) return out;
      try {
        // The buckets are in the environment's project, which a key made in another one names as `<access key>@<project id>`.
        const s3 = await makeControlClient(ctx.appConfig.s3.region, projectId ? projectAccessKey(accessKey, projectId) : accessKey, secretKey);
        const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
        try {
          await s3.send(new ListObjectsV2Command({ Bucket: stateBucket(ctx.appConfig.slug), MaxKeys: 1 }));
          out.stateBucketExists = true;
        } catch (err) {
          if (isNoSuchBucket(err)) out.stateBucketExists = false;
        }
        const controlBucket = deriveInfra(ctx.appConfig).naming.bootDiagBucket;
        try {
          const info = await peekLock(s3, controlBucket, lockKey(ctx.mode));
          out.lock = info
            ? {
                held: true,
                owner: info.owner,
                operation: info.operation,
                acquiredAt: info.acquiredAt,
                expiresAt: info.expiresAt,
                stale: !leaseLive(info),
              }
            : { held: false };
        } catch {
          // Leave lock undefined (reported as unknown).
        }
        try {
          out.live = (await readLiveRecord(s3, controlBucket, ctx.mode)).record;
        } catch {
          // Leave live undefined (reported as unknown).
        }
        try {
          out.applied = (await readAppliedEngine(s3, controlBucket, ctx.mode)) ?? null;
        } catch {
          // Leave applied undefined (reported as unknown).
        }
      } catch {
        // Leave every field undefined (reported as unknown).
      }
      try {
        const { region } = deriveInfra(ctx.appConfig);
        const auth = { secretKey };
        const definitionId = projectId && (await findMainJob({ appConfig: ctx.appConfig, projectId }, auth));
        if (projectId && !definitionId) out.mainJob = null;
        if (projectId && definitionId) {
          const [definition, runs] = await Promise.all([
            readJobDefinition(auth, { region, definitionId }),
            listJobRuns(auth, { region, projectId, definitionId }),
          ]);
          out.mainJob = { definitionId, definition, runs };
        }
      } catch {
        // Leave mainJob undefined (reported as unknown).
      }
      return out;
    })();
    return memo;
  };

  return {
    mode: ctx.mode,
    appConfig: ctx.appConfig,
    stackState: ctx.stackState,
    projectId,
    scalewayKeyAvailable,
    accessKey,
    secretKey,
    operatorKey: ctx.operatorKey,
    hasDomain,
    dbExposureConfigured: dbExposureConfigured(ctx.mode, ctx.stackYaml),
    scalewayFacts,
  };
}

/** Build the full report (provider registry + wall-clock stamp). */
export async function buildReport(ctx: StatusContext): Promise<StatusReport> {
  return buildStatusReport(buildSession(ctx));
}
