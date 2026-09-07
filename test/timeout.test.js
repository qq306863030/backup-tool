'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { adaptConfig } = require('../src/config/adapter');
const { validateConfig } = require('../src/config/schema');
const { calcTotalTimeoutMs, formatDuration } = require('../bin/backup');

const HOUR_MS = 3600 * 1000;

/** 构造一份最小可用的配置 */
function makeConfig(serverOverrides = {}) {
  return {
    servers: [
      {
        host: 'example.com',
        username: 'root',
        password: 'pwd',
        tasks: [
          { name: 't1', type: 'incremental', cron: '0 3 * * *', source: '/remote', destination: '/local' },
        ],
        ...serverOverrides,
      },
    ],
  };
}

test('timeout: 未配置时默认为 -1（不限制）', () => {
  const config = adaptConfig(makeConfig());
  assert.strictEqual(config.servers[0].timeout, -1);
});

test('timeout: 显式配置小时数后原样保留', () => {
  const config = adaptConfig(makeConfig({ timeout: 2 }));
  assert.strictEqual(config.servers[0].timeout, 2);
});

test('timeout: 校验通过 -1 与正数', () => {
  assert.doesNotThrow(() => validateConfig(adaptConfig(makeConfig({ timeout: -1 }))));
  assert.doesNotThrow(() => validateConfig(adaptConfig(makeConfig({ timeout: 0.5 }))));
});

test('timeout: 0 与负数(非-1)应被拒绝', () => {
  assert.throws(
    () => validateConfig(adaptConfig(makeConfig({ timeout: 0 }))),
    /timeout 必须是 -1（不限制）或大于 0 的小时数/
  );
  assert.throws(
    () => validateConfig(adaptConfig(makeConfig({ timeout: -5 }))),
    /timeout 必须是 -1（不限制）或大于 0 的小时数/
  );
});

test('timeout: 字符串类型的非法值应被拒绝', () => {
  assert.throws(
    () => validateConfig(adaptConfig(makeConfig({ timeout: '2h' }))),
    /timeout 必须是 -1（不限制）或大于 0 的小时数/
  );
});

test('calcTotalTimeoutMs: 未配置 timeout 时不限制', () => {
  assert.strictEqual(calcTotalTimeoutMs(makeConfig()), 0);
});

test('calcTotalTimeoutMs: 单个 server 按小时换算为毫秒', () => {
  assert.strictEqual(calcTotalTimeoutMs(makeConfig({ timeout: 2 })), 2 * HOUR_MS);
});

test('calcTotalTimeoutMs: 多个 server 串行执行，超时累加', () => {
  const raw = {
    servers: [
      { timeout: 1, tasks: [] },
      { timeout: 2, tasks: [] },
    ],
  };
  assert.strictEqual(calcTotalTimeoutMs(raw), 3 * HOUR_MS);
});

test('calcTotalTimeoutMs: 任一 server 为 -1 则整体不限制', () => {
  const raw = {
    servers: [
      { timeout: 1, tasks: [] },
      { timeout: -1, tasks: [] },
    ],
  };
  assert.strictEqual(calcTotalTimeoutMs(raw), 0);
});

test('calcTotalTimeoutMs: 未配置 timeout 的 server 视为 -1，整体不限制', () => {
  const raw = {
    servers: [
      { timeout: 3, tasks: [] },
      { tasks: [] }, // 无 timeout 字段
    ],
  };
  assert.strictEqual(calcTotalTimeoutMs(raw), 0);
});

test('calcTotalTimeoutMs: 空 servers 与非法输入不限制', () => {
  assert.strictEqual(calcTotalTimeoutMs({ servers: [] }), 0);
  assert.strictEqual(calcTotalTimeoutMs({}), 0);
  assert.strictEqual(calcTotalTimeoutMs(null), 0);
});

test('calcTotalTimeoutMs: 超过 setTimeout 上限时按不限制处理', () => {
  // 100000 小时 ≈ 360,000,000,000ms，远超 2^31-1
  const raw = { servers: [{ timeout: 100000, tasks: [] }] };
  assert.strictEqual(calcTotalTimeoutMs(raw), 0);
});

test('formatDuration: 按量级自动切换单位', () => {
  assert.strictEqual(formatDuration(2 * HOUR_MS), '2.00 小时');
  assert.strictEqual(formatDuration(90 * 60 * 1000), '1.50 小时');
  assert.strictEqual(formatDuration(5 * 60 * 1000), '5.0 分钟');
  assert.strictEqual(formatDuration(3600), '4 秒');
  assert.strictEqual(formatDuration(0), '0 秒');
});
