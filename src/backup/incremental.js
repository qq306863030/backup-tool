'use strict';

const path = require('path');
const { LocalStorage } = require('../storage/local-storage');
const { needsSync, filterFiles } = require('../utils/file-compare');
const { toRelativePath, safeJoin } = require('../utils/path');

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
    const { source, destination, incremental } = task;
    const { compareBy, deleteRemoved, include, exclude } = incremental;

    this.logger.info(`[incremental] ${task.name}: 开始增量备份 ${source} -> ${destination}`);
    this.storage.ensureDir(destination);

    // 1. 列出远程文件
    const remoteFiles = await connector.listFiles(source);
    const remoteFileEntries = remoteFiles.filter((f) => !f.isDirectory);

    // 2. 过滤
    const relPaths = remoteFileEntries.map((f) => toRelativePath(f.path, source));
    const filtered = filterFiles(relPaths, include, exclude);
    const filteredSet = new Set(filtered);

    // 3. 比较差异
    const toDownload = [];
    let skipped = 0;
    for (const entry of remoteFileEntries) {
      const rel = toRelativePath(entry.path, source);
      if (!filteredSet.has(rel)) continue;

      const localPath = safeJoin(destination, rel);
      const localStat = this.storage.stat(localPath);
      if (needsSync(entry, localStat, compareBy)) {
        toDownload.push({ entry, rel, localPath });
      } else {
        skipped++;
      }
    }

    // 4. 下载文件（串行，ssh2-sftp-client 单连接不支持并发 fastGet）
    const downloaded = await this.downloadWithConcurrency(connector, toDownload);

    // 5. 可选：删除远程已删除的文件
    let removed = 0;
    if (deleteRemoved) {
      removed = this.removeDeleted(destination, filteredSet);
    }

    this.logger.info(
      `[incremental] ${task.name}: 完成，下载 ${downloaded}，跳过 ${skipped}，删除 ${removed}`
    );
    return { downloaded, skipped, removed };
  }

  /**
   * 下载文件（串行）
   * 注意：ssh2-sftp-client 的 fastGet 不支持在同一连接上并发调用，
   * 因此这里必须串行下载，否则会报 "No SFTP connection available"。
   * @param {object} connector
   * @param {Array} jobs [{ entry, rel, localPath }]
   * @returns {Promise<number>} 下载数量
   */
  async downloadWithConcurrency(connector, jobs) {
    let downloaded = 0;
    for (const job of jobs) {
      try {
        this.storage.ensureDir(path.dirname(job.localPath));
        await connector.download(job.entry.path, job.localPath, job.entry.mtime);
        downloaded++;
        this.logger.debug(`[incremental] 下载 ${job.entry.path}`);
      } catch (err) {
        this.logger.error(`[incremental] 下载失败 ${job.entry.path}: ${err.message}`);
      }
    }
    return downloaded;
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
