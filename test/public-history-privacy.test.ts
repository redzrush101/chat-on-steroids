import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.join(process.cwd(), 'scripts', 'verify-public-history.mjs');
const repositories: string[] = [];
const safeEmail = '227782719+totec448-spec@users.noreply.github.com';
const chosenEmail = 'maintainer@example.com';
const sessionUrl = ['https://claude.ai/code/', 'session_exampleIdentifier'].join('');

function makeRepository(): string {
  const repository = mkdtempSync(path.join(tmpdir(), 'public-history-privacy-'));
  repositories.push(repository);
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repository });
  writeFileSync(path.join(repository, 'README.md'), 'clean\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repository });
  commit(repository, 'Clean root', safeEmail);
  return repository;
}

function commit(repository: string, message: string, email: string): void {
  execFileSync('git', ['commit', '--allow-empty', '-m', message], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'totec448-spec',
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: 'totec448-spec',
      GIT_COMMITTER_EMAIL: email,
    },
  });
}

function tag(repository: string, name: string, message: string, email: string): void {
  execFileSync('git', ['tag', '-a', name, '-m', message], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_COMMITTER_NAME: 'totec448-spec',
      GIT_COMMITTER_EMAIL: email,
      GIT_AUTHOR_NAME: 'totec448-spec',
      GIT_AUTHOR_EMAIL: email,
    },
  });
}

function verify(repository: string, args: string[] = [], email = safeEmail) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'totec448-spec', GIT_AUTHOR_EMAIL: email },
  });
}

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe('public-history privacy gate', () => {
  it.each(['\\', '\\\\', '/'])('rejects private roots using %s in staged and committed content without echoing them', separator => {
    const repository = makeRepository();
    const privateRoot = ['C:', 'Users', 'totec'].join(separator);
    writeFileSync(path.join(repository, 'README.md'), `Local root: ${privateRoot}`);
    execFileSync('git', ['add', 'README.md'], { cwd: repository });
    const staged = verify(repository, ['--staged']);
    expect(staged.status).toBe(1);
    expect(staged.stderr).toContain('private Windows user path');
    expect(staged.stderr).not.toContain(privateRoot);
    commit(repository, 'Private fixture', safeEmail);
    expect(verify(repository).status).toBe(1);
  });

  it.each(['outputs/clean.txt', '.codex-remote-attachments/clean.txt'])
    ('rejects tracked evidence %s despite ignore rules and preserves the immutable HEAD check after index-only cleanup', file => {
      const repository = makeRepository();
      mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
      writeFileSync(path.join(repository, file), 'Local evidence retained');
      writeFileSync(path.join(repository, '.gitignore'), `/${file}\n`);
      execFileSync('git', ['add', '-f', '--', file], { cwd: repository });
      expect(verify(repository, ['--staged']).stderr).toContain('tracks private evidence');
      commit(repository, 'Tracked evidence fixture', safeEmail);
      expect(verify(repository).stderr).toContain('tracks private evidence');
      execFileSync('git', ['rm', '--cached', '--', file], { cwd: repository });
      expect(readFileSync(path.join(repository, file), 'utf8')).toBe('Local evidence retained');
      expect(verify(repository, ['--staged']).status).toBe(0);
      expect(verify(repository).status).toBe(1);
    });

  it('excludes local evidence from Git source archives even if forcibly tracked', () => {
    const repository = makeRepository();
    writeFileSync(path.join(repository, '.gitattributes'), readFileSync(path.join(process.cwd(), '.gitattributes')));
    for (const file of ['outputs/evidence.txt', '.codex-remote-attachments/image.txt']) {
      mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
      writeFileSync(path.join(repository, file), 'LOCAL_PRIVATE_EVIDENCE');
      execFileSync('git', ['add', '-f', '--', file], { cwd: repository });
    }
    execFileSync('git', ['add', '.gitattributes'], { cwd: repository });
    commit(repository, 'Archive fixture', safeEmail);
    const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: repository });
    expect(archive.includes(Buffer.from('LOCAL_PRIVATE_EVIDENCE'))).toBe(false);
    expect(archive.includes(Buffer.from('README.md'))).toBe(true);
  });

  it('accepts the numeric GitHub noreply identity', () => {
    const repository = makeRepository();
    const result = verify(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('privacy check passed');
  });

  it('accepts a contributor-chosen email in commit metadata, tracked text, and hooks', () => {
    for (const email of [chosenEmail, ['totec448', 'gmail.com'].join('@')]) {
      const repository = makeRepository();
      writeFileSync(path.join(repository, 'README.md'), `Contact: ${email}\n`);
      execFileSync('git', ['add', 'README.md'], { cwd: repository });
      expect(verify(repository, ['--staged'], email).status).toBe(0);
      commit(repository, 'Public contributor email', email);
      expect(verify(repository, [], email).status).toBe(0);
      const message = path.join(repository, 'COMMIT_EDITMSG');
      writeFileSync(message, `Change\n\nCo-authored-by: Contributor <${email}>\n`);
      expect(verify(repository, ['--message', message], email).status).toBe(0);
      tag(repository, 'v0.0.1-public', 'Public tag', email);
      expect(verify(repository, [], email).status).toBe(0);
    }
  });

  it('rejects Claude session provenance in commit messages without echoing it', () => {
    const repository = makeRepository();
    commit(repository, `Unsafe trailer\n\n${['Claude', 'Session'].join('-')}: ${sessionUrl}`, safeEmail);

    const result = verify(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Claude session');
    expect(result.stderr).not.toContain(sessionUrl);
  });

  /**
   * A full clone carries refs this branch will never contain: other contributors' fetched
   * branches, abandoned local experiments. Those cannot enter the releasable line, so they
   * are not this gate's business — and failing on them made a clean branch look unsafe.
   */
  it('passes a clean checked-out line even when an unrelated ref carries a private session URL', () => {
    const repository = makeRepository();
    execFileSync('git', ['checkout', '-q', '-b', 'unrelated'], { cwd: repository });
    commit(repository, `Private session on unrelated ref ${sessionUrl}`, safeEmail);
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repository });

    const result = verify(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('privacy check passed');
  });

  it('still rejects a private session URL that is an ancestor of HEAD', () => {
    const repository = makeRepository();
    commit(repository, `Private session in ancestry ${sessionUrl}`, safeEmail);
    commit(repository, 'Clean commit on top', safeEmail);

    const result = verify(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Claude session URL');
    expect(result.stderr).not.toContain(sessionUrl);
  });

  /**
   * Once a value is on `origin/main` it is public, so failing every later push cannot unpublish
   * it — it only strands the clone.
   * Taking it out is a deliberate rewrite of a public branch, not a hook's decision.
   */
  it('exempts a session URL that is already published on origin/main', () => {
    const repository = makeRepository();
    commit(repository, `Private session already on main ${sessionUrl}`, safeEmail);
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repository });
    commit(repository, 'Clean local commit on top', safeEmail);

    const result = verify(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('privacy check passed');
  });

  it.each([
    'https://github.com/totec448-spec/chat-on-steroids.git',
    'git@github.com:totec448-spec/chat-on-steroids.git',
    'ssh://git@github.com/totec448-spec/chat-on-steroids'
  ])('recognizes canonical main under an arbitrary remote name (%s)', (url) => {
    const repository = makeRepository();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/fork.git'], { cwd: repository });
    execFileSync('git', ['remote', 'add', 'published', url], { cwd: repository });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repository });
    commit(repository, `Already public canonical commit ${sessionUrl}`, safeEmail);
    execFileSync('git', ['update-ref', 'refs/remotes/published/main', 'HEAD'], { cwd: repository });
    commit(repository, 'Local clean change', safeEmail);
    expect(verify(repository).status).toBe(0);
    commit(repository, `New unpublished private session ${sessionUrl}`, safeEmail);
    expect(verify(repository).status).toBe(1);
  });

  it.each([
    'https://github.com/example/chat-on-steroids.git',
    'https://github.com/totec448-spec/chat-on-steroids-extra.git',
    'https://github.com.example/totec448-spec/chat-on-steroids.git'
  ])('does not trust an unrelated upstream URL (%s)', (url) => {
    const repository = makeRepository();
    execFileSync('git', ['remote', 'add', 'upstream', url], { cwd: repository });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repository });
    commit(repository, `Unpublished private session ${sessionUrl}`, safeEmail);
    execFileSync('git', ['update-ref', 'refs/remotes/upstream/main', 'HEAD'], { cwd: repository });
    expect(verify(repository).status).toBe(1);
  });

  it('does not fall back to fork history when canonical main has not been fetched', () => {
    const repository = makeRepository();
    execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/totec448-spec/chat-on-steroids.git'], { cwd: repository });
    commit(repository, `Only published on a fork ${sessionUrl}`, safeEmail);
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repository });
    expect(verify(repository).status).toBe(1);
  });

  it('still rejects a private session URL a push would add ahead of origin/main', () => {
    const repository = makeRepository();
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repository });
    commit(repository, `Unpublished private session ${sessionUrl}`, safeEmail);

    const result = verify(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Claude session URL');
    expect(result.stderr).not.toContain(sessionUrl);
  });

  it('keeps annotated tags reachable from HEAD under the same checks', () => {
    const repository = makeRepository();
    const sessionUrl = ['https://claude.ai/code/', 'session_taggedIdentifier'].join('');
    tag(repository, 'v0.0.1-test', `Release\n\n${['Claude', 'Session'].join('-')}: ${sessionUrl}`, safeEmail);

    const result = verify(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Claude session');
    expect(result.stderr).not.toContain(sessionUrl);
  });

  it('ignores an annotated tag that is not reachable from HEAD', () => {
    const repository = makeRepository();
    const sessionUrl = ['https://claude.ai/code/', 'session_otherLineIdentifier'].join('');
    execFileSync('git', ['checkout', '-q', '-b', 'other-line'], { cwd: repository });
    commit(repository, 'Only on the other line', safeEmail);
    tag(repository, 'v0.0.2-other', `Release\n\n${['Claude', 'Session'].join('-')}: ${sessionUrl}`, safeEmail);
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repository });

    const result = verify(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('privacy check passed');
  });
});
