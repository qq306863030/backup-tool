'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { needsSync, sameMtime, filterFiles } = require('../src/utils/file-compare');

const remote = { name: 'a.txt', size: 100, mtime: new Date('2026-08-11T03:00:00') };

test('needsSync: 本地不存在需要下载', () => {
  assert.strictEqual(needsSync(remote, null), true);
});

test('needsSync: 完全相同不需要下载', () => {
  const local = { size: 100, mtime: new Date('2026-08-11T03:00:00') };
  assert.strictEqual(needsSync(remote, local), false);
});

test('needsSync: 大小不同需要下载', () => {
  const local = { size: 200, mtime: new Date('2026-08-11T03:00:00') };
  assert.strictEqual(needsSync(remote, local), true);
});

test('needsSync: 修改时间不同在显式指定 mtime 时需要同步', () => {
  const local = { size: 100, mtime: new Date('2026-08-11T05:00:00') };
  assert.strictEqual(needsSync(remote, local, ['name', 'size', 'mtime']), true);
  // 默认情况下不比较 mtime，只比较 name 和 size
  assert.strictEqual(needsSync(remote, local), false);
});

test('needsSync: compareBy 为空则不比较', () => {
  const local = { size: 999, mtime: new Date('2020-01-01') };
  assert.strictEqual(needsSync(remote, local, []), false);
});

test('needsSync: 只比较 size', () => {
  const local = { size: 100, mtime: new Date('2020-01-01') };
  assert.strictEqual(needsSync(remote, local, ['size']), false);
});

test('sameMtime: 容差内相同', () => {
  assert.strictEqual(sameMtime(new Date('2026-08-11T03:00:00'), new Date('2026-08-11T03:00:00.500')), true);
});

test('sameMtime: 超出容差不同', () => {
  assert.strictEqual(sameMtime(new Date('2026-08-11T03:00:00'), new Date('2026-08-11T03:00:05')), false);
});

test('filterFiles: include 优先于 exclude', () => {
  const files = ['a.sql', 'b.sql', 'c.log', 'd.txt'];
  // include 只保留 sql，exclude 再排除 b.sql
  const result = filterFiles(files, ['**/*.sql'], ['**/b.sql']);
  assert.deepStrictEqual(result, ['a.sql']);
});

test('filterFiles: include 为空则处理全部再应用 exclude', () => {
  const files = ['a.sql', 'b.log', 'c.txt'];
  const result = filterFiles(files, [], ['**/*.log']);
  assert.deepStrictEqual(result, ['a.sql', 'c.txt']);
});

test('filterFiles: 无规则返回全部', () => {
  const files = ['a.sql', 'b.log'];
  assert.deepStrictEqual(filterFiles(files), files);
});

test('filterFiles: Windows 反斜杠路径正确处理', () => {
  const files = ['dir\\sub\\a.sql', 'dir\\sub\\b.log'];
  const result = filterFiles(files, ['**/*.sql'], []);
  assert.deepStrictEqual(result, ['dir/sub/a.sql']);
});

test('filterFiles: Windows 反斜杠路径 exclude 正确处理', () => {
  const files = ['dir\\sub\\a.js', 'dir\\sub\\b.tmp'];
  const result = filterFiles(files, [], ['*.tmp', '**/*.tmp']);
  assert.deepStrictEqual(result, ['dir/sub/a.js']);
});

