import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Keep the blocked values split so this guard does not contain the data it rejects.
const blockedText = [
  { label: 'Claude session trailer', value: ['Claude', 'Session:'].join('-') },
  { label: 'Claude session URL', value: ['https://claude.ai/code/', 'session_'].join('') },
  ...['\\', '\\\\', '/'].map(separator => ({
    label: 'private Windows user path', value: ['C:', 'Users', 'totec'].join(separator),
  })),
];

const privateEvidence = ['outputs/', '.codex-remote-attachments/'];

function runGit(args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    throw new Error(`git ${args[0] ?? ''} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function findBlockedText(text, location) {
  const normalized = text.toLowerCase();
  return blockedText
    .filter(({ value }) => normalized.includes(value.toLowerCase()))
    .map(({ label }) => `${location} contains ${label}`);
}

function checkIndexedOrCommittedFiles(treeish) {
  const failures = [];
  const names = String(runGit(treeish === '--cached'
    ? ['ls-files', '--cached', '-z']
    : ['ls-tree', '-r', '--name-only', '-z', treeish]).stdout).split('\0');
  for (const excluded of privateEvidence) {
    if (names.some(name => excluded.endsWith('/') ? name.startsWith(excluded) : name === excluded)) {
      failures.push(`${treeish} tracks private evidence excluded from publication (${excluded})`);
    }
  }
  for (const { label, value } of blockedText) {
    const args = ['grep', '-q', '-I', '-i', '-F', '-e', value];
    if (treeish === '--cached') args.push('--cached');
    else args.push(treeish);
    args.push('--', '.');
    const result = runGit(args, { allowFailure: true });
    if (result.status === 0) failures.push(`${treeish} contains ${label}`);
    else if (result.status !== 1) throw new Error(`git grep failed while checking ${label}`);
  }
  return failures;
}

function checkMessageFile(messagePath) {
  return findBlockedText(readFileSync(messagePath, 'utf8'), 'commit message');
}

/**
 * Commits that are already published on the public main line.
 *
 * The gate exists to keep a private value from *entering* public history. A commit that is
 * already on the canonical repository's main has entered it, and refusing every later local push cannot
 * unpublish it — it only strands the working clone. Those commits are exempt here; everything
 * a local push would actually add stays checked. Removing a value from published history
 * requires a deliberate rewrite of a public branch, not a decision by a pre-push hook.
 *
 * A fork's origin may lag upstream. Select by exact repository URL, never by the name
 * "upstream". Without a canonical remote, retain the legacy origin/main convention.
 * If a configured canonical remote has no fetched main, exempt nothing.
 */
function publishedCommits() {
  const remotes = String(runGit(['remote']).stdout).split(/\r?\n/).filter(Boolean);
  const canonical = remotes.find((remote) => {
    const url = String(runGit(['remote', 'get-url', remote]).stdout).trim();
    return /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)totec448-spec\/chat-on-steroids(?:\.git)?\/?$/i.test(url);
  });
  const publishedRef = `refs/remotes/${canonical ?? 'origin'}/main`;
  const ref = runGit(['rev-parse', '--verify', '--quiet', publishedRef], {
    allowFailure: true,
  });
  if (ref.status !== 0) return new Set();
  const listed = runGit(['rev-list', publishedRef], { allowFailure: true });
  if (listed.status !== 0) return new Set();
  return new Set(String(listed.stdout).split(/\r?\n/).filter(Boolean));
}

function checkHistory() {
  const failures = [];
  const published = publishedCommits();
  // Only history that can actually enter the releasable line. `--all` walks every local and
  // remote-tracking ref in the clone, so an unrelated fetched branch — someone else's fork, an
  // abandoned experiment — could fail verification for a clean checked-out branch that never
  // contains it. A fresh CI checkout has no such refs, which is why this passes there and
  // fails locally on a full clone.
  const head = runGit(['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  const commits =
    head.status === 0
      ? String(runGit(['rev-list', 'HEAD']).stdout)
          .split(/\r?\n/)
          .filter(Boolean)
      : [];
  // pull_request jobs default to a GitHub-generated merge object that can never enter
  // public history. Its identity belongs to GitHub's test ref, not to the proposed tree.
  const syntheticPullRequestCommit =
    process.env.GITHUB_EVENT_NAME === 'pull_request' ? process.env.GITHUB_SHA?.trim() : '';

  for (const commit of commits) {
    if (syntheticPullRequestCommit && commit === syntheticPullRequestCommit) continue;
    if (published.has(commit)) continue;
    const location = `commit ${commit}`;
    const message = String(runGit(['show', '-s', '--format=%B', commit]).stdout);
    failures.push(...findBlockedText(message, `${location} message`));
  }

  // Same rule for tags: an annotated tag reachable from HEAD is part of this line's public
  // history and stays checked. One that is not reachable belongs to a different line.
  const tags =
    head.status === 0
      ? String(runGit(['tag', '--merged', 'HEAD', '--list']).stdout)
          .split(/\r?\n/)
          .filter(Boolean)
      : [];
  for (const tag of tags) {
    const type = String(runGit(['cat-file', '-t', tag]).stdout).trim();
    if (type !== 'tag') continue;
    const message = String(runGit(['for-each-ref', `refs/tags/${tag}`, '--format=%(contents)']).stdout);
    failures.push(...findBlockedText(message, `tag ${tag} message`));
  }

  if (head.status === 0) failures.push(...checkIndexedOrCommittedFiles('HEAD'));
  return { failures, commits: commits.length, tags: tags.length };
}

function fail(failures) {
  console.error('Public-history privacy check failed:');
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exitCode = 1;
}

const [mode, argument] = process.argv.slice(2);
if (mode === '--message') {
  if (!argument) throw new Error('--message requires the commit-message file path.');
  const failures = checkMessageFile(argument);
  if (failures.length > 0) fail(failures);
} else if (mode === '--staged') {
  const failures = checkIndexedOrCommittedFiles('--cached');
  if (failures.length > 0) fail(failures);
} else if (mode) {
  throw new Error(`Unknown argument: ${mode}`);
} else {
  const { failures, commits, tags } = checkHistory();
  if (failures.length > 0) fail(failures);
  else console.log(`Public-history privacy check passed (${commits} commits, ${tags} tags).`);
}
