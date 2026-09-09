'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runConcurrentPool, createAggregatedProgress, formatBytes, formatDurationHMS } = require('../src/utils/concurrent-pool');

test('runConcurrentPool: 空任务数组直接返回', async () => {
  let called = 0;
  await runConcurrentPool([], 4, async () => {
    called++;
  });
  assert.strictEqual(called, 0);

  await runConcurrentPool(null, 4, async () => {
    called++;
  });
  assert.strictEqual(called, 0);
});

test('runConcurrentPool: 控制最大并发数并正确处理所有任务', async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  let currentConcurrent = 0;
  let maxObservedConcurrent = 0;
  const processed = [];

  await runConcurrentPool(items, 3, async (item, idx) => {
    currentConcurrent++;
    maxObservedConcurrent = Math.max(maxObservedConcurrent, currentConcurrent);
    await new Promise((resolve) => setTimeout(resolve, 10));
    processed.push({ item, idx });
    currentConcurrent--;
  });

  assert.strictEqual(processed.length, 8);
  assert.ok(maxObservedConcurrent <= 3, `Max concurrency should be <= 3, got ${maxObservedConcurrent}`);
  assert.strictEqual(maxObservedConcurrent, 3);
});

test('createAggregatedProgress & formatBytes: 格式化与进度计算', () => {
  assert.strictEqual(formatBytes(500), '500 B');
  assert.strictEqual(formatBytes(2048), '2.0 KB');
  assert.strictEqual(formatBytes(1024 * 1024 * 5), '5.00 MB');
  assert.strictEqual(formatBytes(1024 * 1024 * 1024 * 2), '2.00 GB');

  const progress = createAggregatedProgress(1000, 2);
  progress.addBytes(500);
  progress.completeOneFile('file1.txt');
  progress.addBytes(500);
  progress.completeOneFile('file2.txt');
  progress.finish();
});

test('formatDurationHMS: 正确格式化为 HH:mm:ss', () => {
  assert.strictEqual(formatDurationHMS(0), '00:00:00');
  assert.strictEqual(formatDurationHMS(999), '00:00:00');
  assert.strictEqual(formatDurationHMS(1000), '00:00:01');
  assert.strictEqual(formatDurationHMS(65 * 1000), '00:01:05');
  assert.strictEqual(formatDurationHMS((3600 + 120 + 34) * 1000), '01:02:34');
  assert.strictEqual(formatDurationHMS((25 * 3600 + 4 * 60 + 5) * 1000), '25:04:05');
});
