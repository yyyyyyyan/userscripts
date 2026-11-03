import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const { PRE_COMMIT_REMOTE_BRANCH, PRE_COMMIT_FROM_REF, PRE_COMMIT_TO_REF } = process.env;
const isZeros = (ref) => /^0+$/.test(ref ?? '');

if (
  PRE_COMMIT_REMOTE_BRANCH !== 'refs/heads/main' ||
  !PRE_COMMIT_TO_REF ||
  isZeros(PRE_COMMIT_TO_REF)
) {
  process.exit(0);
}

const commitlint = [
  join(root, 'node_modules', '@commitlint', 'cli', 'cli.js'),
  '--config',
  join(root, 'commitlint.config.mjs'),
  '--cwd',
  process.cwd(),
];

let result;
if (!PRE_COMMIT_FROM_REF || isZeros(PRE_COMMIT_FROM_REF)) {
  const message = spawnSync('git', ['log', '-1', '--format=%B', PRE_COMMIT_TO_REF], {
    encoding: 'utf8',
  });
  if (message.status !== 0) {
    process.stderr.write(message.stderr);
    process.exit(message.status ?? 1);
  }
  result = spawnSync(process.execPath, commitlint, {
    input: message.stdout,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
} else {
  result = spawnSync(
    process.execPath,
    [...commitlint, '--from', PRE_COMMIT_FROM_REF, '--to', PRE_COMMIT_TO_REF],
    { stdio: 'inherit' },
  );
}

process.exit(result.status ?? 1);
