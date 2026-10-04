import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { LibtvProvider, parseCliJson, runLibtvCli, makePaidPhotoPrompt } from '../backend/libtv-provider.mjs';

const projectUuid = 'a'.repeat(32);
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-libtv-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'private');
  await mkdir(path.join(root, 'public', 'assets'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(root, 'cli'), 'fake CLI fixture - never executed');
  for (const name of ['cz', 'heyi']) await writeFile(path.join(root, 'public', 'assets', `${name}-reference.jpg`), 'fixture');
  const calls = [];
  let mode = 'success';
  let downloaded = false;
  const run = async (_cli, args) => {
    calls.push(args);
    if (args[0] === 'account') return { user: { id: 1 }, activeAccount: { isActive: true, accountId: 42, memberAccount: { effective: true } } };
    if (args[0] === 'model') return { modality: 'image', schema: { properties: {
      modeType: { items: { image2image: [0, 7] } }, ratio: { enum: ['4:3'] }, quality: { enum: ['2K'] }
    } } };
    if (args[0] === 'node' && args[1] === 'list') return { projectUuid, nodes: [], count: 0 };
    if (args[0] === 'upload') return { nodeKey: `fixture-resource-${calls.length}` };
    if (args[0] === 'node' && args[1] === 'create') return { nodeKey: 'fixture-result-node' };
    if (args.includes('--run')) {
      if (mode === 'ambiguous') throw new Error('lost terminal response after submit');
      if (mode === 'failure') return { success: false, status: 'failed' };
      return { success: true, status: 'completed' };
    }
    if (args[0] === 'node') return { nodeKey: 'fixture-result-node' };
    if (args[0] === 'download') {
      if (mode === 'missing-result') throw new Error('No result yet');
      const dir = args[args.indexOf('-o') + 1];
      await writeFile(path.join(dir, 'result.png'), 'test image bytes; provider does not decode');
      downloaded = true;
      return { success: true };
    }
    throw new Error('Unexpected CLI call');
  };
  const provider = new LibtvProvider({ rootDir: root, dataDir, cliPath: path.join(root, 'cli'),
    projectUuid, accountId: '42', enabled: true, generationBudget: 1, ...overrides }, { run });
  const id = randomUUID();
  const outputDir = path.join(dataDir, id);
  await mkdir(outputDir);
  const inputPath = path.join(outputDir, 'player.jpg');
  await writeFile(inputPath, 'test upload');
  const job = { id, idempotencyKey: id, inputPath, outputDir, character: 'heyi', scene: 'cafe', options: { gender: 'male', body: 'standard', outfit: 'cream' } };
  return { root, dataDir, provider, calls, job, setMode: value => { mode = value; }, downloaded: () => downloaded };
}

test('CLI parser accepts whole JSON and NDJSON terminal output, rejects non-JSON', () => {
  assert.deepEqual(parseCliJson('{"ok":true}'), { ok: true });
  assert.deepEqual(parseCliJson('progress\n{"nodeKey":"a"}\n{"status":"completed"}'), { status: 'completed' });
  assert.throws(() => parseCliJson('unreadable'));
});
test('real child-process download accepts exit-zero text or empty stdout while other commands require JSON', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-libtv-child-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Node executes these fake command-named scripts. No real LibTV binary, account
  // or generation is invoked; this exercises the actual spawn/stdout boundary.
  const download = path.join(root, 'download');
  const model = path.join(root, 'model');
  await writeFile(download, "process.stdout.write('Saved image to private output\\n');");
  assert.deepEqual(await runLibtvCli(process.execPath, ['download'], root), { success: true });
  await writeFile(download, 'process.exitCode = 0;');
  assert.deepEqual(await runLibtvCli(process.execPath, ['download'], root), { success: true });
  await writeFile(download, "process.stdout.write('No completed image'); process.exitCode = 1;");
  await assert.rejects(runLibtvCli(process.execPath, ['download'], root), /operation failed/);
  await writeFile(model, "process.stdout.write('Unexpected non-JSON response');");
  await assert.rejects(runLibtvCli(process.execPath, ['model'], root), /unreadable response/);
  await writeFile(model, "process.stdout.write(JSON.stringify({ modality: 'image' }));");
  assert.deepEqual(await runLibtvCli(process.execPath, ['model'], root), { modality: 'image' });
});
test('disabled and unbudgeted services cannot submit or even call the CLI', async t => {
  const f = await fixture(t, { enabled: false });
  assert.equal((await f.provider.preflight()).ready, false);
  await assert.rejects(f.provider.submit(f.job));
  assert.equal(f.calls.length, 0);
  f.provider.enabled = true;
  f.provider.generationBudget = 0;
  assert.equal((await f.provider.preflight()).ready, false);
  assert.equal(f.calls.length, 0);
});
test('preflight checks configured account, canvas and model without spending credits', async t => {
  const f = await fixture(t);
  const ready = await f.provider.preflight();
  assert.equal(ready.ready, true);
  assert.equal(ready.quotaMode, 'administrator-budget');
  assert.equal(f.calls.some(args => args.includes('--run') || args[0] === 'upload'), false);
  f.provider.accountId = '999';
  assert.equal((await f.provider.preflight()).ready, false);
});
test('one successful order runs once, saves private result, and blocks capacity reuse', async t => {
  const f = await fixture(t);
  const submitted = await f.provider.submit(f.job);
  assert.equal(f.calls.filter(args => args.includes('--run')).length, 1);
  assert.equal(f.downloaded(), true);
  const completed = await f.provider.poll(submitted.providerJobId, f.job);
  assert.equal(completed.status, 'succeeded');
  assert.ok(completed.resultPath.startsWith(f.job.outputDir));
  assert.deepEqual(await f.provider.submit(f.job), submitted);
  assert.equal(f.calls.filter(args => args.includes('--run')).length, 1);
  assert.equal((await f.provider.preflight()).ready, false);
});
test('ambiguous submission consumes budget and never auto-runs again, including recovery', async t => {
  const f = await fixture(t);
  f.setMode('ambiguous');
  await assert.rejects(f.provider.submit(f.job));
  assert.equal(f.calls.filter(args => args.includes('--run')).length, 1);
  await assert.rejects(f.provider.submit(f.job));
  assert.equal(f.calls.filter(args => args.includes('--run')).length, 1);
  const journal = JSON.parse(await readFile(path.join(f.job.outputDir, 'libtv-provider-state.json'), 'utf8'));
  assert.equal(journal.status, 'review_required');
  assert.equal((await f.provider.preflight()).ready, false);
  f.setMode('success');
  const recovery = await f.provider.recover(f.job);
  assert.ok(recovery.providerJobId);
  assert.equal((await f.provider.poll(recovery.providerJobId, f.job)).status, 'succeeded');
  assert.equal(f.calls.filter(args => args.includes('--run')).length, 1);
});
test('failed terminal is preserved without another paid generation', async t => {
  const f = await fixture(t);
  f.setMode('failure');
  const submitted = await f.provider.submit(f.job);
  assert.equal((await f.provider.poll(submitted.providerJobId, f.job)).status, 'failed');
  assert.equal(f.downloaded(), false);
  await f.provider.submit(f.job);
  assert.equal(f.calls.filter(args => args.includes('--run')).length, 1);
});
test('budget allocation serializes and persists across provider instances', async t => {
  const f = await fixture(t);
  const allocations = await Promise.allSettled([f.provider.consumeBudget(randomUUID()), f.provider.consumeBudget(randomUUID())]);
  assert.equal(allocations.filter(result => result.status === 'fulfilled').length, 1);
  const state = JSON.parse(await readFile(path.join(f.dataDir, 'provider-budget.json'), 'utf8'));
  assert.equal(state.started.length, 1);
  assert.equal((await f.provider.preflight()).ready, false);
});
test('invalid order and companion never reach CLI, prompts separate identities and natural necks', async t => {
  const f = await fixture(t);
  await assert.rejects(f.provider.submit({ ...f.job, id: '../../public' }));
  await assert.rejects(f.provider.submit({ ...f.job, character: 'other' }));
  assert.equal(f.calls.length, 0);
  const prompt = makePaidPhotoPrompt(f.job, 'playerNode', 'referenceNode');
  assert.match(prompt, /Node playerNode/);
  assert.match(prompt, /Node referenceNode/);
  assert.match(prompt, /不歪脖/);
});
