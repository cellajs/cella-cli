import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InfraContext } from '../shared';

const runOwnerMoment = vi.fn();
const acquireOperatorKey = vi.fn();
const copyDeployKeyForMainJob = vi.fn();
const recordKeyRotation = vi.fn();
const runOperatorPart = vi.fn();

vi.mock('./install-owner-moment', () => ({ runOwnerMoment: (...args: unknown[]) => runOwnerMoment(...args) }));
vi.mock('./operator-unlock', () => ({ acquireOperatorKey: (...args: unknown[]) => acquireOperatorKey(...args) }));
vi.mock('../session', () => ({ rememberOperatorKey: () => {}, inMenuSession: () => false, runEnvironment: () => undefined }));
vi.mock('./install-checklist', () => ({ printLaunchChecklist: async () => {} }));
vi.mock('./install-operator-part', () => ({
  copyDeployKeyForMainJob: (...args: unknown[]) => copyDeployKeyForMainJob(...args),
  recordKeyRotation: (...args: unknown[]) => recordKeyRotation(...args),
  runOperatorPart: (...args: unknown[]) => runOperatorPart(...args),
}));

const { runInstall } = await import('./install');

const context = { environment: 'staging', projectId: 'project-staging', hasCiKey: true, appConfig: { slug: 'demo' } } as InfraContext;
const operator = { accessKey: 'SCWOPERATOR', secretKey: 'operator-secret', organizationId: 'org-1' };
const ciKey = { accessKey: 'SCWNEWDEPLOY', secretKey: 'new-deploy-secret', projectId: 'project-staging', organizationId: 'org-1' };

beforeEach(() => {
  vi.clearAllMocks();
  acquireOperatorKey.mockResolvedValue(operator);
  copyDeployKeyForMainJob.mockResolvedValue(true);
  runOwnerMoment.mockResolvedValue({ projectId: 'project-staging', ciKey });
});

describe('runInstall', () => {
  it("copies the deploy key a rotation made before recording it: the rotation deleted the key the main job's copy held", async () => {
    await runInstall(context, 'rotate-keys');
    expect(copyDeployKeyForMainJob).toHaveBeenCalledWith(context, operator, 'project-staging', ciKey);
    expect(copyDeployKeyForMainJob.mock.invocationCallOrder[0]).toBeLessThan(recordKeyRotation.mock.invocationCallOrder[0] ?? 0);
    expect(runOperatorPart).not.toHaveBeenCalled();
  });

  it('leaves the copy to the operator part on an install, which writes it with the rest of the engine folder', async () => {
    await runInstall({ ...context, hasCiKey: false }, 'resume');
    expect(runOperatorPart).toHaveBeenCalledOnce();
    expect(copyDeployKeyForMainJob).not.toHaveBeenCalled();
    expect(recordKeyRotation).not.toHaveBeenCalled();
  });

  it('asks a rotation for the operator key before its Owner moment deletes a key, and stops when the moment was declined', async () => {
    runOwnerMoment.mockResolvedValue(undefined);
    await runInstall(context, 'rotate-keys');
    expect(acquireOperatorKey.mock.invocationCallOrder[0]).toBeLessThan(runOwnerMoment.mock.invocationCallOrder[0] ?? 0);
    expect(copyDeployKeyForMainJob).not.toHaveBeenCalled();
    expect(recordKeyRotation).not.toHaveBeenCalled();
  });

  it('records no rotation and starts no deploy when the copy failed: those deploys would run on the key the rotation deleted', async () => {
    copyDeployKeyForMainJob.mockResolvedValue(false);
    await expect(runInstall(context, 'rotate-keys')).rejects.toThrow(/exit code 1/);
    expect(recordKeyRotation).not.toHaveBeenCalled();
  });

  it('records no rotation when the Owner key could not list the older deploy keys: the lost key still works', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    runOwnerMoment.mockResolvedValue({ projectId: 'project-staging', ciKey: { ...ciKey, purgeSkipped: true } });
    await expect(runInstall(context, 'rotate-keys')).rejects.toThrow(/exit code 1/);
    expect(recordKeyRotation).not.toHaveBeenCalled();
  });

  it('records no rotation when the Owner moment made no new deploy key: the lost key still works', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    runOwnerMoment.mockResolvedValue({ projectId: 'project-staging', ciKey: { accessKey: '', secretKey: '', organizationId: '' } });
    await expect(runInstall(context, 'rotate-keys')).rejects.toThrow(/exit code 1/);
    expect(recordKeyRotation).not.toHaveBeenCalled();
  });

  it('records no rotation when the uploads key was not replaced: the lost deploy key read the old one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    runOwnerMoment.mockResolvedValue({ projectId: 'project-staging', ciKey, uploadsKeyKept: true });
    await expect(runInstall(context, 'rotate-keys')).rejects.toThrow(/exit code 1/);
    expect(recordKeyRotation).not.toHaveBeenCalled();
  });
});
