import type { Command } from '../command';
import { runAudit } from './audit';

export const auditCommand: Command<'report' | 'fix', 'report' | 'fix'> = {
  name: 'audit',
  group: 'security',
  description:
    'outdated packages and runtime pins, and the security overrides a fresh audit asks for; fix updates them',
  // Outside a repository `git ls-files` finds no Dockerfile, and only the image pins go unread
  outsideGit: true,
  jobs: [
    ['report', 'the outdated packages, runtime pins and security plan; in a terminal it then asks to update'],
    ['fix', 'ask which updates and security decisions to take, then write them with one install'],
  ],
  parse: ({ job }) => job,
  run: (repoRoot, job) => runAudit(repoRoot, job === 'fix'),
};
