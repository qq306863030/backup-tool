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

const { parseSize, runAdaptivePool } = require('../src/utils/concurrent-pool');

test('parseSize: 支持数字与容量字符串转换', () => {
  assert.strictEqual(parseSize(1024), 1024);
  assert.strictEqual(parseSize('10MB'), 10 * 1024 * 1024);
  assert.strictEqual(parseSize('50M'), 50 * 1024 * 1024);
  assert.strictEqual(parseSize('1GB'), 1024 * 1024 * 1024);
  assert.strictEqual(parseSize('500KB'), 500 * 1024);
  assert.strictEqual(parseSize('invalid', 12345), 12345);
});

test('runAdaptivePool: 纯小文件按并发数正常执行', async () => {
  const items = [
    { name: 's1', size: 1024 },
    { name: 's2', size: 2048 },
    { name: 's3', size: 4096 },
    { name: 's4', size: 8192 },
  ];
  let currentConcurrent = 0;
  let maxObserved = 0;
  const processed = [];

  await runAdaptivePool(
    items,
    {
      concurrency: 3,
      largeThreshold: 10 * 1024 * 1024,
      getSize: (item) => item.size,
    },
    async (item, idx) => {
      currentConcurrent++;
      maxObserved = Math.max(maxObserved, currentConcurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      processed.push({ item, idx });
      currentConcurrent--;
    }
  );

  assert.strictEqual(processed.length, 4);
  assert.strictEqual(maxObserved, 3);
});

test('runAdaptivePool: 大于等于10MB的大文件自动使用单线程串行执行', async () => {
  const items = [
    { name: 'big1.zip', size: 15 * 1024 * 1024 },
    { name: 'big2.zip', size: 20 * 1024 * 1024 },
    { name: 'big3.zip', size: 100 * 1024 * 1024 },
  ];
  let currentConcurrent = 0;
  let maxObserved = 0;
  const processed = [];

  await runAdaptivePool(
    items,
    {
      concurrency: 4, // 即使指定了 4 并发
      largeThreshold: 10 * 1024 * 1024, // 10MB
      getSize: (item) => item.size,
    },
    async (item, idx) => {
      currentConcurrent++;
      maxObserved = Math.max(maxObserved, currentConcurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      processed.push({ item, idx });
      currentConcurrent--;
    }
  );

  assert.strictEqual(processed.length, 3);
  // 大文件必须严格单线程
  assert.strictEqual(maxObserved, 1);
});

test('runAdaptivePool: 大小混合场景，小文件并发且大文件串行', async () => {
  const items = [
    { name: 'small1.txt', size: 1024 },
    { name: 'big1.zip', size: 20 * 1024 * 1024 },
    { name: 'small2.txt', size: 2048 },
    { name: 'small3.txt', size: 4096 },
    { name: 'big2.rar', size: 50 * 1024 * 1024 },
  ];
  let currentConcurrent = 0;
  let maxSmallConcurrent = 0;
  let maxLargeConcurrent = 0;
  const processOrder = [];

  await runAdaptivePool(
    items,
    {
      concurrency: 3,
      largeThreshold: 10 * 1024 * 1024,
      getSize: (item) => item.size,
    },
    async (item, idx) => {
      currentConcurrent++;
      if (item.size >= 10 * 1024 * 1024) {
        maxLargeConcurrent = Math.max(maxLargeConcurrent, currentConcurrent);
      } else {
        maxSmallConcurrent = Math.max(maxSmallConcurrent, currentConcurrent);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
      processOrder.push(item.name);
      currentConcurrent--;
    }
  );

  assert.strictEqual(processOrder.length, 5);
  // 小文件先完成，大文件后执行
  assert.strictEqual(maxSmallConcurrent, 3);
  assert.strictEqual(maxLargeConcurrent, 1);
  assert.ok(processOrder.indexOf('big1.zip') > processOrder.indexOf('small1.txt'));
  assert.ok(processOrder.indexOf('big2.rar') > processOrder.indexOf('small3.txt'));
});
