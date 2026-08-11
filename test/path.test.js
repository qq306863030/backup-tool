'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  formatTimestamp,
  buildBackupDirName,
  extractTimestamp,
  isBackupDir,
  safeJoin,
  toRelativePath,
} = require('../src/utils/path');

test('formatTimestamp 默认格式', () => {
  const ts = formatTimestamp(new Date('2026-08-11T03:00:00'));
  assert.match(ts, /^\d{8}-\d{6}$/);
});

test('formatTimestamp 自定义格式', () => {
  const ts = formatTimestamp(new Date('2026-08-11T03:00:00'), 'YYYYMMDD');
  assert.strictEqual(ts, '20260811');
});

test('buildBackupDirName 生成 name_时间戳', () => {
  const name = buildBackupDirName('nginx', new Date('2026-08-11T03:00:00'), 'YYYYMMDD-HHmmss');
  assert.strictEqual(name, 'nginx_20260811-030000');
});

test('extractTimestamp 解析时间戳', () => {
  assert.strictEqual(extractTimestamp('nginx_20260811-030000', 'nginx'), '20260811-030000');
  assert.strictEqual(extractTimestamp('other_20260811', 'nginx'), null);
});

test('isBackupDir 判断', () => {
  assert.strictEqual(isBackupDir('nginx_20260811', 'nginx'), true);
  assert.strictEqual(isBackupDir('other_20260811', 'nginx'), false);
});

test('safeJoin 正常拼接', () => {
  const base = path.resolve('base');
  const p = safeJoin(base, 'sub/file.txt');
  assert.strictEqual(p, path.join(base, 'sub', 'file.txt'));
});

test('safeJoin 拒绝路径穿越', () => {
  const base = path.resolve('base');
  assert.throws(() => safeJoin(base, '../evil.txt'));
});

test('toRelativePath 去掉 source 前缀', () => {
  assert.strictEqual(toRelativePath('/data/sub/a.txt', '/data'), 'sub/a.txt');
  assert.strictEqual(toRelativePath('/data/a.txt', '/data/'), 'a.txt');
});

test('toRelativePath source 是单个文件返回文件名', () => {
  assert.strictEqual(toRelativePath('/roman/clash.tar', '/roman/clash.tar'), 'clash.tar');
});
