// One-click revert of an auto-fix: opens a pull request that undoes the fix's squash commit.
// GitHub has no "revert" API, so we build the revert ourselves with the git data API:
//   new tree = main's current tree, with every file the fix touched put back exactly as it was before the fix
//   (files the fix added are deleted, renamed files are renamed back).
// That is only a correct revert when the fix is still the LATEST change to every file it touched. If a later commit
// changed one of those files, we refuse and point to GitHub's own Revert button on the pull request instead
// (it can merge the changes properly). Uses the GITHUB_TOKEN secret (permissions: README "Secrets").
import { ALLOWED_REPOS } from './checks.js';

const API = 'https://api.github.com';
export const BASE_BRANCH = 'main';
export const MAX_FILES = 30; // keeps one revert well inside the Worker's subrequest limit
const REVERTABLE = new Set(['merged', 'deployed', 'verified']);

export class RevertRefused extends Error {}

/**
 * Why this fix can't be reverted automatically (null = it can). Pure.
 * @param entry         the autofixes row
 * @param commit        GitHub commit ({ sha, parents: [{sha}], files: [{filename, status, previous_filename}] }) or null
 * @param latestByFile  Map path -> sha of the latest commit on main that touched it
 */
export function revertProblem(entry, commit, latestByFile) {
  if (!ALLOWED_REPOS.includes(entry.repo)) return `Repository ${entry.repo} is not on the allowed list.`;
  if (entry.revert_pr_url) return `A revert was already opened: ${entry.revert_pr_url}`;
  if (!REVERTABLE.has(entry.status)) return `Only merged fixes can be reverted (this one is "${entry.status}").`;
  if (!entry.merge_sha || !/^[0-9a-f]{40}$/i.test(entry.merge_sha)) return 'This fix has no merge commit recorded.';
  if (!commit) return null; // the entry-level checks passed; GitHub checks follow
  if ((commit.parents || []).length !== 1) return 'The fix was merged with a merge commit, not a squash commit. Use the Revert button on the pull request in GitHub.';
  const files = commit.files || [];
  if (!files.length) return 'The fix commit changed no files.';
  if (files.length > MAX_FILES) return `The fix changed ${files.length} files (more than ${MAX_FILES}). Use the Revert button on the pull request in GitHub.`;
  const later = [];
  for (const f of files) {
    for (const p of [f.filename, f.previous_filename].filter(Boolean)) {
      const latest = latestByFile.get(p);
      if (latest && latest !== commit.sha) later.push(`${p} (changed again in ${latest.slice(0, 7)})`);
    }
  }
  if (later.length) {
    return `Files the fix touched were changed again later, so an automatic revert could undo someone else's work: ${later.join(', ')}. ` +
      'Use the Revert button on the fix\'s pull request in GitHub, which merges the changes properly.';
  }
  return null;
}

/** Tree entries that put every touched file back as it was in the parent. Pure. */
export function revertTreeEntries(files, parentTree) {
  const byPath = new Map(parentTree.map((e) => [e.path, e]));
  const out = [];
  const restore = (path) => {
    const p = byPath.get(path);
    if (!p) throw new RevertRefused(`${path} isn't in the commit before the fix.`);
    if (p.type !== 'blob') throw new RevertRefused(`${path} is a ${p.type}, not a file; revert it in GitHub.`);
    out.push({ path, mode: p.mode, type: 'blob', sha: p.sha });
  };
  const remove = (path) => out.push({ path, mode: '100644', type: 'blob', sha: null });
  for (const f of files) {
    if (f.status === 'added' || f.status === 'copied') remove(f.filename);
    else if (f.status === 'renamed') { remove(f.filename); restore(f.previous_filename); }
    else restore(f.filename); // modified, changed, removed
  }
  return out;
}

export async function gh(env, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
      'user-agent': 'yondr-ops', ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]}: ${res.status} ${data.message || ''}`.trim());
  return data;
}

/**
 * Open the revert PR. `log(message)` records each step in the auto-fix's audit log.
 * Returns { pr_url, branch, auto_merge }.
 */
export async function openRevertPr(env, entry, log) {
  if (!env.GITHUB_TOKEN) throw new RevertRefused('The GITHUB_TOKEN secret is not set, so ops cannot open pull requests yet.');
  const pre = revertProblem(entry, null, new Map());
  if (pre) throw new RevertRefused(pre);
  const repo = entry.repo;
  const sha = entry.merge_sha.toLowerCase();
  const commit = await gh(env, 'GET', `/repos/${repo}/commits/${sha}`);
  const latestByFile = new Map();
  const paths = [...new Set((commit.files || []).slice(0, MAX_FILES + 1).flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))];
  if ((commit.files || []).length <= MAX_FILES) {
    for (const p of paths) {
      const hist = await gh(env, 'GET', `/repos/${repo}/commits?sha=${BASE_BRANCH}&path=${encodeURIComponent(p)}&per_page=1`);
      if (hist[0]) latestByFile.set(p, hist[0].sha);
    }
  }
  const problem = revertProblem(entry, commit, latestByFile);
  if (problem) throw new RevertRefused(problem);
  await log(`Checked ${commit.files.length} file(s): the fix is still the latest change to each.`);

  const parentSha = commit.parents[0].sha;
  const [ref, parentCommit] = await Promise.all([
    gh(env, 'GET', `/repos/${repo}/git/ref/heads/${BASE_BRANCH}`),
    gh(env, 'GET', `/repos/${repo}/git/commits/${parentSha}`),
  ]);
  const headSha = ref.object.sha;
  const [headCommit, parentTree] = await Promise.all([
    gh(env, 'GET', `/repos/${repo}/git/commits/${headSha}`),
    gh(env, 'GET', `/repos/${repo}/git/trees/${parentCommit.tree.sha}?recursive=1`),
  ]);
  if (parentTree.truncated) throw new RevertRefused('The repository is too large to revert automatically. Use the Revert button in GitHub.');
  const entries = revertTreeEntries(commit.files, parentTree.tree);
  const tree = await gh(env, 'POST', `/repos/${repo}/git/trees`, { base_tree: headCommit.tree.sha, tree: entries });
  // No personal details in commit messages or PR text: the repositories are public.
  const message = `Revert "${entry.title}"\n\nThis reverts commit ${sha} (auto-fix #${entry.id}).\nRequested in the Yondr ops dashboard.`;
  const newCommit = await gh(env, 'POST', `/repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [headSha] });
  const branch = `autofix-revert/${entry.id}-${sha.slice(0, 7)}`;
  await gh(env, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: newCommit.sha });
  await log(`Created branch ${branch} with revert commit ${newCommit.sha.slice(0, 7)}.`);
  const pr = await gh(env, 'POST', `/repos/${repo}/pulls`, {
    title: `Revert: ${entry.title}`, head: branch, base: BASE_BRANCH,
    body: `Reverts auto-fix #${entry.id}${entry.pr_url ? ` (${entry.pr_url})` : ''}, commit ${sha}.\n\n` +
      'Requested by an admin in the Yondr ops dashboard (ops.overyondrdev.com). Every file the fix changed is put back as it was ' +
      'before the fix; nothing else changes.\n\nIf checks pass, this pull request merges automatically when auto-merge is allowed in this repository.',
  });
  await log(`Opened pull request #${pr.number}: ${pr.html_url}`);
  await gh(env, 'POST', `/repos/${repo}/issues/${pr.number}/labels`, { labels: ['autofix-revert'] })
    .catch((e) => log(`Couldn't add the autofix-revert label: ${e.message}`));
  let autoMerge = false;
  try {
    const q = await gh(env, 'POST', '/graphql', {
      query: 'mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId } }',
      variables: { id: pr.node_id },
    });
    if (q.errors && q.errors.length) throw new Error(q.errors.map((e) => e.message).join('; '));
    autoMerge = true;
    await log('Auto-merge (squash) enabled: it merges once the required checks pass.');
  } catch (e) {
    await log(`Auto-merge not enabled (${e.message}). Merge the pull request in GitHub once checks pass.`);
  }
  return { pr_url: pr.html_url, branch, auto_merge: autoMerge };
}
