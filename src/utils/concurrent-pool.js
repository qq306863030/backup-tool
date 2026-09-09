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

module.exports = {
  formatBytes,
  formatDurationHMS,
  runConcurrentPool,
  createAggregatedProgress,
};
