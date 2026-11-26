import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { writeFinalDump } from './final-dump';

describe('writeFinalDump', () => {
  it('deletes the exported backup, and its download link with it, when the download fails', async () => {
    const backup = { id: 'backup-1', name: 'db-final', status: 'ready', database_name: 'db', download_url: 'https://rdb.example/backup-1.dump' };
    const deleteBackup = vi.fn(async () => {});
    const dump = writeFinalDump({
      rdb: {
        findInstance: async () => ({ id: 'instance-1', name: 'db-instance', status: 'ready' }),
        listDatabases: async () => [{ name: 'db' }],
        createBackup: async () => backup,
        getBackup: async () => backup,
        exportBackup: async () => backup,
        deleteBackup,
      },
      instanceName: 'db-instance',
      databaseName: 'db',
      environment: 'staging',
      backupDays: 7,
      bucket: 'boot-diag',
      s3: new S3Client({ region: 'nl-ams' }),
      download: async () => new Response(null, { status: 403 }),
      log: () => {},
    });
    await expect(dump).rejects.toThrow(/answered 403/);
    expect(deleteBackup).toHaveBeenCalledWith('backup-1');
  });
});
