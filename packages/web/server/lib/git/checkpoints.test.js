import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureWorktreeSnapshot,
  deleteCheckpointRef,
  restoreSnapshotFiles,
} from './service.js';

// The checkpoint primitives turn the worktree's Git object database into
// per-turn snapshots, so the tests run against real repositories in temporary
// directories. The fixture mirrors `service.test.js`'s infrastructure.

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-checkpoints-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.platform === 'win32'
      ? { ...process.env, MSYS: [process.env.MSYS, 'noglob'].filter(Boolean).join(' ') }
      : process.env,
  });

const createRepository = () => {
  const repository = createTempDir();
  runGit(repository, ['init', '-b', 'main']);
  runGit(repository, ['config', 'user.email', 'test@example.com']);
  runGit(repository, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repository, '.gitignore'), 'dist/\n');
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'before\n');
  fs.mkdirSync(path.join(repository, 'nested'));
  fs.writeFileSync(path.join(repository, 'nested', 'kept.txt'), 'kept\n');
  runGit(repository, ['add', '.']);
  runGit(repository, ['commit', '-m', 'init']);
  return repository;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

describe('captureWorktreeSnapshot', () => {
  it('freezes tracked and untracked files without touching the repository index', async () => {
    const repository = createRepository();
    fs.writeFileSync(path.join(repository, 'untracked.txt'), 'untraced before\n');
    runGit(repository, ['add', 'nested']);
    const stagedBefore = runGit(repository, ['diff', '--cached', '--name-only']);

    const snapshot = await captureWorktreeSnapshot(repository, {
      refName: 'refs/openchamber/checkpoints/ses_one/msg_two/base',
    });

    expect(snapshot.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(runGit(repository, ['for-each-ref', '--format=%(refname)', 'refs/openchamber/checkpoints'])).toContain(
      'refs/openchamber/checkpoints/ses_one/msg_two/base',
    );
    expect(runGit(repository, ['diff', '--cached', '--name-only'])).toBe(stagedBefore);
    expect(
      runGit(repository, ['cat-file', '-p', `refs/openchamber/checkpoints/ses_one/msg_two/base:untracked.txt`]),
    ).toBe('untraced before\n');
  });

  it('snapshots a repository without any commit', async () => {
    const repository = createTempDir();
    runGit(repository, ['init', '-b', 'main']);
    runGit(repository, ['config', 'user.email', 'test@example.com']);
    runGit(repository, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repository, 'first.txt'), 'seed\n');

    const snapshot = await captureWorktreeSnapshot(repository, {
      refName: 'refs/openchamber/checkpoints/ses_three/msg_four/base',
    });
    expect(runGit(repository, ['cat-file', '-p', `${snapshot.tree}:first.txt`])).toBe('seed\n');
  });

  it('reports every file even when the tree is empty', async () => {
    const repository = createTempDir();
    runGit(repository, ['init', '-b', 'main']);
    await expect(captureWorktreeSnapshot(repository, { refName: 'refs/openchamber/checkpoints/s/x/base' })).resolves
      .toMatchObject({ refName: 'refs/openchamber/checkpoints/s/x/base' });
  });

  it('rejects refs outside the checkpoint namespace and non-repositories', async () => {
    const repository = createRepository();
    await expect(captureWorktreeSnapshot(repository, { refName: 'refs/heads/main' })).rejects.toThrow(
      /Invalid checkpoint ref/,
    );
    await expect(captureWorktreeSnapshot(createTempDir(), {
      refName: 'refs/openchamber/checkpoints/s/x/base',
    })).rejects.toThrow();
  });
});

describe('restoreSnapshotFiles', () => {
  it('returns files the turn changed, recreates deleted ones and removes new ones', async () => {
    const repository = createRepository();
    const snapshot = await captureWorktreeSnapshot(repository, {
      refName: 'refs/openchamber/checkpoints/ses_one/msg_two/base',
    });

    fs.writeFileSync(path.join(repository, 'tracked.txt'), 'after agent\n');
    fs.rmSync(path.join(repository, 'nested', 'kept.txt'));
    fs.writeFileSync(path.join(repository, 'nested', 'created.txt'), 'created by agent\n');
    fs.chmodSync(path.join(repository, 'tracked.txt'), 0o755);

    const outcome = await restoreSnapshotFiles(repository, snapshot.tree, [
      'tracked.txt',
      'nested/kept.txt',
      'nested/created.txt',
    ]);

    expect(outcome.restored).toEqual(['tracked.txt', 'nested/kept.txt']);
    expect(outcome.removed).toEqual(['nested/created.txt']);
    expect(outcome.skipped).toEqual([]);
    expect(fs.readFileSync(path.join(repository, 'tracked.txt'), 'utf8')).toBe('before\n');
    expect(fs.existsSync(path.join(repository, 'nested', 'kept.txt'))).toBe(true);
    expect(fs.existsSync(path.join(repository, 'nested', 'created.txt'))).toBe(false);
    const mode = runGit(repository, ['ls-files', '-s', 'tracked.txt']).split(' ')[0];
    expect(mode).not.toBe('100755');
  });

  it('keeps the staged area and ignored files untouched, and skips directories', async () => {
    const repository = createRepository();
    const snapshot = await captureWorktreeSnapshot(repository, {
      refName: 'refs/openchamber/checkpoints/ses_one/msg_two/base',
    });
    fs.mkdirSync(path.join(repository, 'dist'));
    fs.writeFileSync(path.join(repository, 'dist', 'ignored-after.txt'), 'ignored\n');
    fs.writeFileSync(path.join(repository, 'nested', 'kept.txt'), 'staged edit\n');
    runGit(repository, ['add', 'nested']);

    const outcome = await restoreSnapshotFiles(repository, snapshot.tree, [
      'dist/ignored-after.txt',
      'nested',
    ]);

    expect(outcome.skipped).toEqual([
      { path: 'dist/ignored-after.txt', reason: 'ignored' },
      { path: 'nested', reason: 'tree' },
    ]);
    expect(fs.existsSync(path.join(repository, 'dist', 'ignored-after.txt'))).toBe(true);
    expect(runGit(repository, ['diff', '--cached', '--name-only'])).toBe('nested/kept.txt\n');
  });

  it('recreates a symlink the turn replaced with a regular file', async () => {
    const repository = createRepository();
    fs.symlinkSync('tracked.txt', path.join(repository, 'link.txt'));
    runGit(repository, ['add', 'link.txt']);
    runGit(repository, ['commit', '-m', 'link']);
    const snapshot = await captureWorktreeSnapshot(repository, {
      refName: 'refs/openchamber/checkpoints/ses_one/msg_two/base',
    });

    fs.rmSync(path.join(repository, 'link.txt'));
    fs.writeFileSync(path.join(repository, 'link.txt'), 'now a file\n');

    const outcome = await restoreSnapshotFiles(repository, snapshot.tree, ['link.txt']);

    expect(outcome.restored).toEqual(['link.txt']);
    expect(fs.lstatSync(path.join(repository, 'link.txt')).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(repository, 'link.txt'))).toBe(
      fs.realpathSync(path.join(repository, 'tracked.txt')),
    );
  });

  it('throws on malformed trees, outside paths, and empty file lists', async () => {
    const repository = createRepository();
    await expect(restoreSnapshotFiles(repository, 'not-a-tree', ['tracked.txt'])).rejects.toThrow(/checkpoint/);
    await expect(restoreSnapshotFiles(repository, 'a'.repeat(40), [])).rejects.toThrow(/at least one file/);
    await expect(
      restoreSnapshotFiles(repository, 'a'.repeat(40), ['../outside.txt']),
    ).rejects.toThrow(/outside repository/);
  });
});

describe('deleteCheckpointRef', () => {
  it('drops the ref once and stays quiet when it is already gone', async () => {
    const repository = createRepository();
    const { refName } = await captureWorktreeSnapshot(repository, { refName: 'refs/openchamber/checkpoints/s/x/base' });
    await expect(deleteCheckpointRef(repository, refName)).resolves.toBe(true);
    expect(runGit(repository, ['for-each-ref', 'refs/openchamber/checkpoints'])).toBe('');
    await expect(deleteCheckpointRef(repository, refName)).resolves.toBe(false);
    await expect(deleteCheckpointRef(repository, 'refs/heads/main')).rejects.toThrow(/Invalid checkpoint ref/);
  });
});
