// One-click revert: when it is refused, and the git-data-API revert against a mocked GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openRevertPr, revertProblem, revertTreeEntries, RevertRefused } from '../src/github.js';
import { mockFetch } from './helpers.js';

const SHA = 'a'.repeat(40);
const LATER = 'b'.repeat(40);
const PARENT = 'c'.repeat(40);
const entry = { id: 7, repo: 'Overyondrdev/overyondr-website-v1', title: 'Fix footer link', status: 'merged', merge_sha: SHA, pr_url: 'https://github.com/Overyondrdev/overyondr-website-v1/pull/99' };
const commit = { sha: SHA, parents: [{ sha: PARENT }], files: [
  { filename: 'src/a.html', status: 'modified' }, { filename: 'src/new.css', status: 'added' }, { filename: 'src/b2.js', previous_filename: 'src/b.js', status: 'renamed' }] };

test('refusals: not merged, already reverted, unknown repo, merge commits, too many files', () => {
  assert.match(revertProblem({ ...entry, status: 'pr_open' }, null, new Map()), /Only merged fixes/);
  assert.match(revertProblem({ ...entry, revert_pr_url: 'https://github.com/x' }, null, new Map()), /already opened/);
  assert.match(revertProblem({ ...entry, repo: 'someone/else' }, null, new Map()), /not on the allowed list/);
  assert.match(revertProblem({ ...entry, merge_sha: null }, null, new Map()), /no merge commit/);
  assert.match(revertProblem(entry, { ...commit, parents: [{ sha: PARENT }, { sha: LATER }] }, new Map()), /merge commit/);
  assert.match(revertProblem(entry, { ...commit, files: Array.from({ length: 31 }, (_, i) => ({ filename: `f${i}`, status: 'modified' })) }, new Map()), /more than 30/);
  assert.equal(revertProblem(entry, commit, new Map([['src/a.html', SHA], ['src/new.css', SHA], ['src/b2.js', SHA], ['src/b.js', SHA]])), null);
});

test('refused when a later commit touched the same files, pointing to GitHub\'s Revert button', () => {
  const msg = revertProblem(entry, commit, new Map([['src/a.html', LATER], ['src/new.css', SHA]]));
  assert.match(msg, /src\/a\.html \(changed again in bbbbbbb\)/);
  assert.match(msg, /Revert button/);
});

test('tree entries put files back: modified → old blob, added → deleted, renamed → renamed back', () => {
  const parentTree = [{ path: 'src/a.html', mode: '100644', type: 'blob', sha: '1'.repeat(40) }, { path: 'src/b.js', mode: '100755', type: 'blob', sha: '2'.repeat(40) }];
  assert.deepEqual(revertTreeEntries(commit.files, parentTree), [
    { path: 'src/a.html', mode: '100644', type: 'blob', sha: '1'.repeat(40) },
    { path: 'src/new.css', mode: '100644', type: 'blob', sha: null },
    { path: 'src/b2.js', mode: '100644', type: 'blob', sha: null },
    { path: 'src/b.js', mode: '100755', type: 'blob', sha: '2'.repeat(40) },
  ]);
  assert.throws(() => revertTreeEntries([{ filename: 'gone', status: 'modified' }], parentTree), RevertRefused);
});

function github(t, { latest = SHA, autoMerge = true } = {}) {
  return mockFetch(t, (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const m = init.method || 'GET';
    assert.equal(init.headers.authorization, 'Bearer gh-test');
    const R = 'https://api.github.com/repos/Overyondrdev/overyondr-website-v1';
    if (m === 'GET' && url === `${R}/commits/${SHA}`) return Response.json(commit);
    if (m === 'GET' && p.endsWith('/commits') && u.searchParams.get('path')) return Response.json([{ sha: u.searchParams.get('path') === 'src/a.html' ? latest : SHA }]);
    if (m === 'GET' && p.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'd'.repeat(40) } });
    if (m === 'GET' && p.endsWith(`/git/commits/${PARENT}`)) return Response.json({ tree: { sha: 'e'.repeat(40) } });
    if (m === 'GET' && p.endsWith(`/git/commits/${'d'.repeat(40)}`)) return Response.json({ tree: { sha: 'f'.repeat(40) } });
    if (m === 'GET' && p.endsWith(`/git/trees/${'e'.repeat(40)}`)) return Response.json({ truncated: false, tree: [
      { path: 'src/a.html', mode: '100644', type: 'blob', sha: '1'.repeat(40) }, { path: 'src/b.js', mode: '100644', type: 'blob', sha: '2'.repeat(40) }] });
    if (m === 'POST' && p.endsWith('/git/trees')) { const b = JSON.parse(init.body); assert.equal(b.base_tree, 'f'.repeat(40)); assert.equal(b.tree.length, 4); return Response.json({ sha: '9'.repeat(40) }); }
    if (m === 'POST' && p.endsWith('/git/commits')) { const b = JSON.parse(init.body); assert.deepEqual(b.parents, ['d'.repeat(40)]); assert.doesNotMatch(b.message, /@/); return Response.json({ sha: '8'.repeat(40) }); }
    if (m === 'POST' && p.endsWith('/git/refs')) { assert.equal(JSON.parse(init.body).ref, 'refs/heads/autofix-revert/7-aaaaaaa'); return Response.json({}, { status: 201 }); }
    if (m === 'POST' && p.endsWith('/pulls')) { const b = JSON.parse(init.body); assert.equal(b.title, 'Revert: Fix footer link'); assert.doesNotMatch(b.body, /@overyondr/); return Response.json({ number: 101, html_url: 'https://github.com/Overyondrdev/overyondr-website-v1/pull/101', node_id: 'PR_1' }, { status: 201 }); }
    if (m === 'POST' && p.endsWith('/issues/101/labels')) { assert.deepEqual(JSON.parse(init.body).labels, ['autofix-revert']); return Response.json([]); }
    if (m === 'POST' && p === '/graphql') return autoMerge ? Response.json({ data: {} }) : Response.json({ errors: [{ message: 'Auto merge is not allowed for this repository' }] });
    return Response.json({ message: `unexpected ${m} ${url}` }, { status: 500 });
  });
}

test('opens the revert PR with label and auto-merge, logging each step', async (t) => {
  const calls = github(t);
  const log = [];
  const r = await openRevertPr({ GITHUB_TOKEN: 'gh-test' }, entry, async (m) => log.push(m));
  assert.equal(r.pr_url, 'https://github.com/Overyondrdev/overyondr-website-v1/pull/101');
  assert.equal(r.auto_merge, true);
  assert.ok(log.some((l) => /Opened pull request #101/.test(l)));
  assert.ok(calls.length < 50, 'stays inside the subrequest limit');
});

test('auto-merge not allowed is recorded, not fatal; a later commit refuses before writing anything', async (t) => {
  github(t, { autoMerge: false });
  const log = [];
  const r = await openRevertPr({ GITHUB_TOKEN: 'gh-test' }, entry, async (m) => log.push(m));
  assert.equal(r.auto_merge, false);
  assert.ok(log.some((l) => /Auto-merge not enabled/.test(l)));
});

test('a later change to a touched file refuses, with no writes to GitHub', async (t) => {
  const calls = github(t, { latest: LATER });
  await assert.rejects(openRevertPr({ GITHUB_TOKEN: 'gh-test' }, entry, async () => {}), (e) => e instanceof RevertRefused && /changed again/.test(e.message));
  assert.ok(calls.every((c) => (c.init.method || 'GET') === 'GET'));
  await assert.rejects(openRevertPr({}, entry, async () => {}), /GITHUB_TOKEN/);
});
