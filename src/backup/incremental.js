'use strict';

const path = require('path');
const { LocalStorage } = require('../storage/local-storage');
const { needsSync, filterFiles } = require('../utils/file-compare');
const { toRelativePath, safeJoin } = require('../utils/path');
const { formatBytes, formatDurationHMS, runConcurrentPool, createAggregatedProgress } = require('../utils/concurrent-pool');

/**
 * 增量备份引擎：镜像同步，只下载有差异的文件
 */
class IncrementalBackup {
  /**
   * @param {object} logger
   */
  constructor(logger) {
    this.logger = logger;
    this.storage = new LocalStorage();
  }

  /**
   * 执行增量备份
   * @param {object} connector SFTP 连接器
   * @param {object} task 内部标准任务配置
   * @returns {Promise<{downloaded: number, skipped: number, removed: number}>}
   */
  async run(connector, task) {
    const { name, source, destination, checkConcurrency, concurrency, incremental } = task;
    const { compareBy, deleteRemoved, include, exclude } = incremental;

    const t0 = Date.now();
    this.logger.info(`[incremental] ${name}: 开始增量备份比对... (比对并发: ${checkConcurrency || 8})`);
    this.storage.ensureDir(destination);

    // 1. 列出远程文件（并发扫描）
    const remoteFiles = await connector.listFiles(source, checkConcurrency || 8);
    const remoteFileEntries = remoteFiles.filter((f) => !f.isDirectory);

    // 2. 过滤
    const relPaths = remoteFileEntries.map((f) =>
      toRelativePath(f.path, source).replace(/\/+/g, '/').replace(/^\/+/, '')
    );
    const filtered = filterFiles(relPaths, include, exclude);
    const filteredSet = new Set(filtered);

    // 3. 比较差异
    const toDownload = [];
    let skipped = 0;
    let totalDownloadBytes = 0;

    for (const entry of remoteFileEntries) {
      const rel = toRelativePath(entry.path, source).replace(/\/+/g, '/').replace(/^\/+/, '');
      if (!filteredSet.has(rel)) continue;

      const localPath = safeJoin(destination, rel);
      const localStat = this.storage.stat(localPath);
      if (needsSync(entry, localStat, compareBy)) {
        toDownload.push({ entry, rel, localPath });
        totalDownloadBytes += entry.size;
      } else {
        skipped++;
      }
    }

    this.logger.info(
      `[incremental] ${name}: 发现 ${toDownload.length} 个文件待下载（${formatBytes(totalDownloadBytes)}），跳过 ${skipped} 个`
    );

    // 4. 受控并发批量下载
    let downloaded = 0;
    const progress = createAggregatedProgress(totalDownloadBytes, toDownload.length);

    await runConcurrentPool(toDownload, concurrency || 4, async (job) => {
      try {
        this.storage.ensureDir(path.dirname(job.localPath));
        let prevTransferred = 0;
        await connector.downloadResume(job.entry.path, job.localPath, job.entry.mtime, (transferred) => {
          const delta = transferred - prevTransferred;
          prevTransferred = transferred;
          if (delta > 0) progress.addBytes(delta);
        });
        downloaded++;
        progress.completeOneFile(job.rel);
        this.logger.debug(`[incremental] 下载完成 ${job.entry.path}`);
      } catch (err) {
        this.logger.error(`[incremental] 下载失败 ${job.entry.path}: ${err.message}`);
      }
    });

    progress.finish();

    // 5. 可选：删除远程已删除的文件
    let removed = 0;
    if (deleteRemoved) {
      removed = this.removeDeleted(destination, filteredSet);
    }

    const totalDuration = formatDurationHMS(Date.now() - t0);
    this.logger.info(
      `[incremental] ${name}: 增量备份全部完成！总耗时: ${totalDuration}, 下载: ${downloaded}, 跳过: ${skipped}, 删除: ${removed}`
    );
    return { downloaded, skipped, removed, duration: totalDuration };
  }

  /**
   * 删除本地存在但远程已删除（且未被过滤）的文件
   * @param {string} destination
   * @param {Set<string>} remoteRelPaths 远程相对路径集合
   * @returns {number} 删除数量
   */
  removeDeleted(destination, remoteRelPaths) {
    const localFiles = this.storage.listFiles(destination);
    let removed = 0;
    for (const rel of localFiles) {
      if (!remoteRelPaths.has(rel)) {
        this.storage.remove(safeJoin(destination, rel));
        this.logger.info(`[incremental] 删除本地多余文件 ${rel}`);
        removed++;
      }
    }
    return removed;
  }
}

module.exports = { IncrementalBackup };
