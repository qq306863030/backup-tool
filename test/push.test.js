'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { IncrementalPush } = require('../src/backup/incremental-push');
const { FullPush } = require('../src/backup/full-push');

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

test('IncrementalPush: 正确对比并上传有差异/新增的文件', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-push-test-'));
  const file1 = path.join(tmpDir, 'file1.txt');
  const file2 = path.join(tmpDir, 'file2.txt');
  fs.writeFileSync(file1, 'hello 1', 'utf-8');
  fs.writeFileSync(file2, 'hello 2', 'utf-8');

  const uploadedFiles = [];
  const deletedFiles = [];

  const stat1 = fs.statSync(file1);
  const remoteEntries = [
    {
      name: 'file1.txt',
      path: '/remote/dir/file1.txt',
      size: stat1.size,
      mtime: stat1.mtime.getTime(),
      isDirectory: false,
    },
    {
      name: 'old.txt',
      path: '/remote/dir/old.txt',
      size: 10,
      mtime: 1000,
      isDirectory: false,
    },
  ];
  const mockConnector = {
    // connector.listFiles 返回 {name, path, size, mtime, isDirectory}
    listFiles: async () => remoteEntries,
    // 惰性按目录查询：只返回该目录的直接子项
    listDir: async (dir) => (dir === '/remote/dir' ? remoteEntries : []),
    uploadResume: async (local, remote) => {
      uploadedFiles.push({ local, remote });
    },
    deleteFile: async (remote) => {
      deletedFiles.push(remote);
    },
    ensureRemoteDir: async () => {},
    setRemoteMtime: async () => {},
  };

  const pusher = new IncrementalPush(mockLogger);
  const result = await pusher.run(mockConnector, {
    name: 'test-push',
    source: tmpDir,
    destination: '/remote/dir',
    incremental: {
      compareBy: ['size', 'mtime'],
      deleteRemoved: true,
      include: [],
      exclude: [],
    },
  });

  // file1.txt 大小和时间相同应跳过，file2.txt 新增应上传，old.txt 在本地不存在应删除
  assert.strictEqual(result.uploadedCount, 1);
  assert.strictEqual(result.skippedCount, 1);
  assert.strictEqual(result.deletedCount, 1);
  assert.strictEqual(uploadedFiles.length, 1);
  assert.strictEqual(uploadedFiles[0].remote, '/remote/dir/file2.txt');
  assert.strictEqual(deletedFiles.length, 1);
  assert.strictEqual(deletedFiles[0], '/remote/dir/old.txt');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('IncrementalPush: 按目录惰性查询远程，每个目录只 list 一次', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-list-test-'));
  // 本地结构: a/f1.txt, a/f2.txt, b/sub/f3.txt  —— 共 3 个文件、2 个远程目录
  fs.mkdirSync(path.join(tmpDir, 'a'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'b', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'a', 'f1.txt'), '1');
  fs.writeFileSync(path.join(tmpDir, 'a', 'f2.txt'), '2');
  fs.writeFileSync(path.join(tmpDir, 'b', 'sub', 'f3.txt'), '3');

  const listedDirs = [];
  const mockConnector = {
    // 后台全量遍历：模拟一个很大的远程树，但主流程不应依赖它完成
    listFiles: async () => {
      await new Promise((r) => setTimeout(r, 50)); // 模拟慢速远程遍历
      return [];
    },
    // 惰性单目录查询：记录被查询的目录
    listDir: async (dir) => {
      listedDirs.push(dir);
      return [];
    },
    uploadResume: async () => {},
    deleteFile: async () => {},
    ensureRemoteDir: async () => {},
    setRemoteMtime: async () => {},
  };

  const pusher = new IncrementalPush(mockLogger);
  const result = await pusher.run(mockConnector, {
    name: 'lazy-list',
    source: tmpDir,
    destination: '/remote/dir',
    incremental: { compareBy: ['size', 'mtime'], deleteRemoved: false, include: [], exclude: [] },
  });

  // 3 个文件全为新增，都应上传
  assert.strictEqual(result.uploadedCount, 3);

  // 只查询了本地文件实际所在的 2 个目录，且每个目录只查一次
  assert.deepStrictEqual(listedDirs.sort(), ['/remote/dir/a', '/remote/dir/b/sub']);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('IncrementalPush: 后台清单就绪后不再逐目录查询', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefetch-test-'));
  fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
  const f1 = path.join(tmpDir, 'sub', 'f1.txt');
  fs.writeFileSync(f1, 'content');
  const st = fs.statSync(f1);

  const listedDirs = [];
  const mockConnector = {
    // 后台遍历立即可用，且已包含该文件 → 主循环应命中缓存
    listFiles: async () => [
      { name: 'f1.txt', path: '/remote/sub/f1.txt', size: st.size, mtime: st.mtime.getTime(), isDirectory: false },
    ],
    listDir: async (dir) => {
      listedDirs.push(dir);
      return [];
    },
    uploadResume: async () => {},
    deleteFile: async () => {},
    ensureRemoteDir: async () => {},
    setRemoteMtime: async () => {},
  };

  const pusher = new IncrementalPush(mockLogger);
  const result = await pusher.run(mockConnector, {
    name: 'prefetch',
    source: tmpDir,
    destination: '/remote',
    incremental: { compareBy: ['size', 'mtime'], deleteRemoved: false, include: [], exclude: [] },
  });

  // 后台清单里该文件完全一致，应跳过上传
  assert.strictEqual(result.skippedCount, 1);
  assert.strictEqual(result.uploadedCount, 0);
  // 缓存已完整，不应再发起任何逐目录 list
  assert.strictEqual(listedDirs.length, 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('FullPush: 非压缩模式上传所有文件并清理远程超期版本', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-push-test-'));
  const file1 = path.join(tmpDir, 'app.js');
  fs.writeFileSync(file1, 'console.log("hello");', 'utf-8');

  const uploadedFiles = [];
  const deletedRemotes = [];

  const mockConnector = {
    // connector.listFiles 返回 {name, path, size, mtime, isDirectory}
    listFiles: async (dir) => {
      if (dir === '/remote/backups') {
        return [
          { name: 'full-task_20260101-000000', path: '/remote/backups/full-task_20260101-000000', isDirectory: true, mtime: 100, size: 0 },
          { name: 'full-task_20260102-000000', path: '/remote/backups/full-task_20260102-000000', isDirectory: true, mtime: 200, size: 0 },
          { name: 'full-task_20260103-000000', path: '/remote/backups/full-task_20260103-000000', isDirectory: true, mtime: 300, size: 0 },
          { name: 'full-task_20260828-120000', path: '/remote/backups/full-task_20260828-120000', isDirectory: true, mtime: 400, size: 0 },
        ];
      }
      return [];
    },
    ensureRemoteDir: async () => {},
    uploadResume: async (local, remote) => {
      uploadedFiles.push({ local, remote });
    },
    deleteFile: async (remote) => {
      deletedRemotes.push(remote);
    },
    deleteDir: async (remote) => {
      deletedRemotes.push(remote);
    },
  };

  const pusher = new FullPush(mockLogger);
  const result = await pusher.run(mockConnector, {
    name: 'full-task',
    source: tmpDir,
    destination: '/remote/backups',
    full: {
      maxBackups: 2,
      timestampFormat: 'YYYYMMDD-HHmmss',
      compress: false,
      exclude: [],
    },
  });

  assert.strictEqual(result.uploadedCount, 1);
  assert.strictEqual(result.cleanedCount, 2); // 原有3个 + 新增1个 = 4个，maxBackups=2，应清理2个
  assert.strictEqual(deletedRemotes.length, 2);
  assert.strictEqual(deletedRemotes[0], '/remote/backups/full-task_20260101-000000');
  assert.strictEqual(deletedRemotes[1], '/remote/backups/full-task_20260102-000000');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
