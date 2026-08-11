'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Retention } = require('../src/storage/retention');

let tmpRoot;
let logger;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
  logger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// 每个测试使用独立子目录，避免状态污染
function makeDir() {
  return fs.mkdtempSync(path.join(tmpRoot, 'case-'));
}

function makeBackup(dir, name, timestamp) {
  const d = path.join(dir, `${name}_${timestamp}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function makeZipBackup(dir, name, timestamp) {
  const f = path.join(dir, `${name}_${timestamp}.zip`);
  fs.writeFileSync(f, 'zip-content');
  return f;
}

test('retention: 未超上限不删除', () => {
  const dir = makeDir();
  makeBackup(dir, 'nginx', '20260811-010000');
  makeBackup(dir, 'nginx', '20260811-020000');
  const retention = new Retention(logger);
  const removed = retention.cleanup(dir, 'nginx', 5);
  assert.deepStrictEqual(removed, []);
});

test('retention: 超出上限删除最老的', () => {
  const dir = makeDir();
  makeBackup(dir, 'nginx', '20260811-010000');
  makeBackup(dir, 'nginx', '20260811-020000');
  makeBackup(dir, 'nginx', '20260811-030000');
  makeBackup(dir, 'nginx', '20260811-040000');
  const retention = new Retention(logger);
  const removed = retention.cleanup(dir, 'nginx', 2);
  assert.deepStrictEqual(removed, ['nginx_20260811-010000', 'nginx_20260811-020000']);
  assert.strictEqual(fs.existsSync(path.join(dir, 'nginx_20260811-010000')), false);
  assert.strictEqual(fs.existsSync(path.join(dir, 'nginx_20260811-040000')), true);
});

test('retention: 只清理属于该任务的备份', () => {
  const dir = makeDir();
  makeBackup(dir, 'nginx', '20260811-010000');
  makeBackup(dir, 'other', '20260811-010000');
  const retention = new Retention(logger);
  const removed = retention.cleanup(dir, 'nginx', 0);
  assert.deepStrictEqual(removed, ['nginx_20260811-010000']);
  assert.strictEqual(fs.existsSync(path.join(dir, 'other_20260811-010000')), true);
});

test('retention: dryRun 不实际删除', () => {
  const dir = makeDir();
  makeBackup(dir, 'nginx', '20260811-010000');
  makeBackup(dir, 'nginx', '20260811-020000');
  const retention = new Retention(logger);
  const removed = retention.cleanup(dir, 'nginx', 1, true);
  assert.deepStrictEqual(removed, ['nginx_20260811-010000']);
  assert.strictEqual(fs.existsSync(path.join(dir, 'nginx_20260811-010000')), true);
});

test('retention: 识别 zip 备份并清理最老的', () => {
  const dir = makeDir();
  makeZipBackup(dir, 'nginx', '20260811-010000');
  makeZipBackup(dir, 'nginx', '20260811-020000');
  makeZipBackup(dir, 'nginx', '20260811-030000');
  makeZipBackup(dir, 'nginx', '20260811-040000');
  const retention = new Retention(logger);
  const removed = retention.cleanup(dir, 'nginx', 2);
  assert.deepStrictEqual(removed, ['nginx_20260811-010000.zip', 'nginx_20260811-020000.zip']);
  assert.strictEqual(fs.existsSync(path.join(dir, 'nginx_20260811-010000.zip')), false);
  assert.strictEqual(fs.existsSync(path.join(dir, 'nginx_20260811-040000.zip')), true);
});

test('retention: 混合目录和 zip 备份', () => {
  const dir = makeDir();
  makeBackup(dir, 'nginx', '20260811-010000');
  makeZipBackup(dir, 'nginx', '20260811-020000');
  makeZipBackup(dir, 'nginx', '20260811-030000');
  const retention = new Retention(logger);
  const removed = retention.cleanup(dir, 'nginx', 2);
  assert.deepStrictEqual(removed, ['nginx_20260811-010000']);
});
