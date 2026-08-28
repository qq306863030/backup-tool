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
  const mockConnector = {
    // connector.listFiles 返回 {name, path, size, mtime, isDirectory}
    listFiles: async () => [
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
    ],
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
