'use strict';

/**
 * 格式化字节数为人类可读格式
 * @param {number} bytes 字节数
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 受控并发 Worker 队列
 * @template T
 * @param {Array<T>} items 待处理任务数组
 * @param {number} concurrency 并发数
 * @param {function(T, number): Promise<void>} taskFn 处理单个任务的异步函数 (item, index) => Promise<void>
 * @returns {Promise<void>}
 */
async function runConcurrentPool(items, concurrency, taskFn) {
  if (!items || items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency || 1, items.length));
  let cursor = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await taskFn(items[idx], idx);
    }
  });

  await Promise.all(workers);
}

/**
 * 创建并发传输时的全局聚合进度条
 * @param {number} totalBytes 总传输字节数
 * @param {number} totalFiles 总传输文件数
 * @returns {{ addBytes: function(number): void, completeOneFile: function(string=): void, render: function(): void, finish: function(): void }}
 */
function createAggregatedProgress(totalBytes, totalFiles) {
  let transferredBytes = 0;
  let finishedFiles = 0;
  let lastTick = 0;
  let lastLen = 0;

  const progress = {
    addBytes(delta) {
      transferredBytes += delta;
      this.render();
    },
    completeOneFile(_fileName) {
      finishedFiles++;
      this.render();
    },
    render() {
      // 非 TTY 环境或无输出时不刷进度条
      if (!process.stdout || !process.stdout.isTTY) return;

      const now = Date.now();
      if (now - lastTick < 100) return; // 100ms 节流
      lastTick = now;

      const pct = totalBytes > 0 ? Math.min(100, (transferredBytes / totalBytes) * 100) : 100;
      const text = `传输进度: [${finishedFiles}/${totalFiles} 文件] ${formatBytes(transferredBytes)}/${formatBytes(totalBytes)} (${pct.toFixed(1)}%)`;
      process.stdout.write('\r' + ' '.repeat(lastLen) + '\r' + text);
      lastLen = text.length;
    },
    finish() {
      if (process.stdout && process.stdout.isTTY && lastLen > 0) {
        process.stdout.write('\r' + ' '.repeat(lastLen) + '\r');
      }
    },
  };

  return progress;
}

/**
 * 将毫秒数格式化为 HH:mm:ss 格式
 * @param {number} ms 毫秒数
 * @returns {string} HH:mm:ss
 */
function formatDurationHMS(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

const DEFAULT_LARGE_FILE_THRESHOLD = 10 * 1024 * 1024; // 10MB

/**
 * 解析文件大小配置（支持数字或如 "10MB", "50M", "1GB" 的字符串）
 * @param {number|string} val
 * @param {number} [defaultBytes=10485760]
 * @returns {number} 字节数
 */
function parseSize(val, defaultBytes = DEFAULT_LARGE_FILE_THRESHOLD) {
  if (typeof val === 'number' && !Number.isNaN(val) && val >= 0) {
    return Math.floor(val);
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
    if (match) {
      const num = parseFloat(match[1]);
      const unit = (match[2] || 'B').toUpperCase();
      const multipliers = {
        B: 1,
        K: 1024,
        KB: 1024,
        M: 1024 * 1024,
        MB: 1024 * 1024,
        G: 1024 * 1024 * 1024,
        GB: 1024 * 1024 * 1024,
        T: 1024 * 1024 * 1024 * 1024,
        TB: 1024 * 1024 * 1024 * 1024,
      };
      if (multipliers[unit]) {
        return Math.floor(num * multipliers[unit]);
      }
    }
  }
  return defaultBytes;
}

/**
 * 自适应并发池：
 * 对低于阈值的小文件使用受控并发（concurrency），
 * 对大于等于阈值的大文件自动切换为单线程串行传输（concurrency = 1），
 * 彻底避免多路大文件在单个 SSH 链路或带宽受限下交错拥塞导致心跳超时断开。
 *
 * @template T
 * @param {Array<T>} items 待处理任务数组
 * @param {object} [options] 调度选项
 * @param {number} [options.concurrency=4] 小文件并发数
 * @param {number} [options.largeThreshold=10485760] 大文件阈值（字节数，默认 10MB）
 * @param {function(T): number} [options.getSize] 获取任务项文件大小的函数
 * @param {object} [options.logger] logger 实例
 * @param {function(T, number): Promise<void>} taskFn 处理单个任务的异步函数 (item, index) => Promise<void>
 * @returns {Promise<void>}
 */
async function runAdaptivePool(items, options, taskFn) {
  if (!items || items.length === 0) return;

  const concurrency = Math.max(1, options?.concurrency || 4);
  const largeThreshold = options?.largeThreshold ?? DEFAULT_LARGE_FILE_THRESHOLD;
  const getSize = typeof options?.getSize === 'function' ? options.getSize : (item) => (item && typeof item.size === 'number' ? item.size : 0);
  const logger = options?.logger;

  // 若阈值 <= 0 或 concurrency 已为 1，直接执行普通并发池
  if (largeThreshold <= 0 || concurrency <= 1) {
    return runConcurrentPool(items, concurrency, taskFn);
  }

  const smallItems = [];
  const largeItems = [];

  for (const item of items) {
    const size = getSize(item);
    if (size >= largeThreshold) {
      largeItems.push(item);
    } else {
      smallItems.push(item);
    }
  }

  // 1. 纯小文件场景
  if (largeItems.length === 0) {
    return runConcurrentPool(smallItems, concurrency, taskFn);
  }

  // 2. 纯大文件场景：全部单线程串行
  if (smallItems.length === 0) {
    if (logger && largeItems.length > 1) {
      logger.info(
        `[pool] 检测到待传输的 ${largeItems.length} 个文件均大于等于 ${formatBytes(largeThreshold)}，自动启用单线程串行传输以保障长连接稳定`
      );
    }
    return runConcurrentPool(largeItems, 1, taskFn);
  }

  // 3. 混合场景：先并发传输小文件，后单线程串行传输大文件
  if (logger) {
    logger.info(
      `[pool] 自动分流调度: ${smallItems.length} 个小文件(<${formatBytes(largeThreshold)})以 ${concurrency} 并发传输，` +
      `${largeItems.length} 个大文件(>=${formatBytes(largeThreshold)})自动降级为单线程串行传输`
    );
  }

  let globalIndex = 0;
  await runConcurrentPool(smallItems, concurrency, (item) => taskFn(item, globalIndex++));
  await runConcurrentPool(largeItems, 1, (item) => taskFn(item, globalIndex++));
}

module.exports = {
  DEFAULT_LARGE_FILE_THRESHOLD,
  formatBytes,
  formatDurationHMS,
  parseSize,
  runConcurrentPool,
  runAdaptivePool,
  createAggregatedProgress,
};

