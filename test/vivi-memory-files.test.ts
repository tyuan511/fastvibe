import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ViviMemoryFiles, emptyState, initialTree, readMemoryTree } from '../src/main/bot/memory/files.ts';

test('persistent publication and journal recovery publish the same complete generation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vivi-files-'));
  try {
    const files = new ViviMemoryFiles(join(dir, 'memories'));
    await files.locked(() => files.publish(initialTree(), emptyState()));
    const next = initialTree(); next.set('MEMORY.md', '# New generation\n');
    const state = emptyState(); state.generation = 2;
    writeFileSync(files.journal, JSON.stringify({ version: 1, tree: [...next], state }));
    // Simulate a crash after only the first member was renamed.
    writeFileSync(join(files.root, 'MEMORY.md'), '# New generation\n');
    const reopened = new ViviMemoryFiles(files.root);
    await reopened.locked(() => {
      assert.equal(reopened.snapshot().state.generation, 2);
      assert.deepEqual(readMemoryTree(reopened.baseline), next);
      assert.deepEqual(reopened.snapshot().tree, next);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('two instances serialize access and reject symlink files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vivi-files-'));
  try {
    const a = new ViviMemoryFiles(join(dir, 'memories')), b = new ViviMemoryFiles(a.root);
    await a.locked(() => a.publish(initialTree(), emptyState()));
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = a.locked(async () => { order.push('a'); await held; order.push('end'); });
    const second = b.locked(() => { order.push('b'); });
    release(); await Promise.all([first, second]);
    assert.deepEqual(order, ['a','end','b']);
    symlinkSync(join(dir, 'outside.md'), join(a.root, 'bad.md'));
    await assert.rejects(a.locked(() => a.snapshot()), /Symbolic/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('dead lock owner is recovered and invalid journal never overwrites valid documents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vivi-files-'));
  try {
    const files = new ViviMemoryFiles(join(dir, 'memories'));
    await files.locked(() => files.publish(initialTree(), emptyState()));
    mkdirSync(files.lock); writeFileSync(join(files.lock, 'owner.json'), JSON.stringify({pid: 2147483647, token:'dead'}));
    await files.locked(() => assert.equal(files.snapshot().tree.get('MEMORY.md'), '# Vivi memory\n'));
    writeFileSync(files.journal, JSON.stringify({version:1,tree:[['MEMORY.md','bad'],['memory_summary.md','invalid']],state:emptyState()}));
    await assert.rejects(files.locked(() => {}), /Invalid memory summary/);
    assert.equal(readFileSync(join(files.root, 'MEMORY.md'),'utf8'), '# Vivi memory\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
