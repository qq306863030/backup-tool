'use strict';

const path = require('path');
const fs = require('fs');
const { needsSync, filterFiles } = require('../utils/file-compare');
const { toRelativePath, toPosixPath } = require('../utils/path');
const { LocalStorage } = require('../storage/local-storage');
const { formatBytes, formatDurationHMS, runConcurrentPool, createAggregatedProgress } = require('../utils/concurrent-pool');

/**
 * 增量推送引擎 (Push 模式)
 * 将本地 source 目录增量同步推送到远程 destination 目录
 */
class IncrementalPush {
  constructor(logger, storage) {
    this.logger = logger;
    this.storage = storage || new LocalStorage();
  }

  /**
   * 执行增量推送
   * @param {import('../connectors/sftp').SftpConnector} connector
   * @param {Object} task
   */
  async run(connector, task) {
    const { name, source, destination, checkConcurrency, concurrency, incremental } = task;
    const { compareBy, deleteRemoved, include, exclude } = incremental;

    this.logger.info(`[incremental-push] ${name}: 开始增量推送比对... (比对并发: ${checkConcurrency || 8})`);

    // ==========================================
    // 阶段一：快速比对（本地扫描 + 远程并发 BFS 扫描）
    // ==========================================
    const t0 = Date.now();
    const [allLocalRelPaths, remoteEntries] = await Promise.all([
      this.storage.listFiles(source),
      connector.listFiles(destination, checkConcurrency || 8).catch((err) => {
        // 远程目录不存在：视为空列表，全新上传
        if (/no such file|not exist|ENOENT/i.test(err.message)) {
          return [];
        }
        throw err;
      }),
    ]);

    // 1. 过滤并收集本地文件
    const cleanLocalRelPaths = allLocalRelPaths.map((rel) =>
      toPosixPath(rel).replace(/\/+/g, '/').replace(/^\/+/, '')
    );
    const filteredRelPaths = new Set(filterFiles(cleanLocalRelPaths, include, exclude));
    const targetLocalFiles = cleanLocalRelPaths
      .filter((rel) => filteredRelPaths.has(rel))
      .map((cleanRel) => {
        const full = path.resolve(source, cleanRel);
        let size = 0;
        let mtime = new Date();
        try {
          const stat = fs.statSync(full);
          size = stat.size;
          mtime = stat.mtime;
        } catch (e) {
          // ignore
        }
        return {
          relativePath: cleanRel,
          fullPath: full,
          size,
          mtime,
        };
      });

    // 2. 构建远程 Map 索引 (O(1) 查找)
    const remoteMap = new Map(); // posixRelPath -> { size, mtime, path }
    for (const entry of remoteEntries) {
      if (!entry.isDirectory) {
        const rel = toPosixPath(toRelativePath(entry.path, destination)).replace(/\/+/g, '/').replace(/^\/+/, '');
        remoteMap.set(rel, { size: entry.size, mtime: new Date(entry.mtime), path: entry.path });
      }
    }

    // 3. 内存比对，计算差异清单
    const toUpload = [];
    let skippedCount = 0;
    let totalUploadBytes = 0;

    for (const local of targetLocalFiles) {
      const remote = remoteMap.get(local.relativePath);
      if (needsSync(remote, local, compareBy)) {
        toUpload.push(local);
        totalUploadBytes += local.size;
      } else {
        skippedCount++;
      }
    }

    const scanDuration = Date.now() - t0;
    this.logger.info(
      `[incremental-push] ${name}: 比对完成（耗时 ${scanDuration}ms），扫描 ${targetLocalFiles.length} 个文件，` +
      `待上传 ${toUpload.length} 个（${formatBytes(totalUploadBytes)}），跳过 ${skippedCount} 个`
    );

    // ==========================================
    // 阶段二：受控并发批量上传
    // ==========================================
    let uploadedCount = 0;
    let failedCount = 0;
    const progress = createAggregatedProgress(totalUploadBytes, toUpload.length);

    await runConcurrentPool(toUpload, concurrency || 4, async (local) => {
      const remoteTarget = toPosixPath(path.posix.join(toPosixPath(destination), local.relativePath));
      const remoteDir = path.posix.dirname(remoteTarget);

      try {
        // 确保远程目录存在
        await connector.ensureRemoteDir(remoteDir);

        // 执行流式上传（带进度统计）
        let prevTransferred = 0;
        await connector.uploadResume(local.fullPath, remoteTarget, (transferred) => {
          const delta = transferred - prevTransferred;
          prevTransferred = transferred;
          if (delta > 0) progress.addBytes(delta);
        });

        // 同步远程 mtime
        await connector.setRemoteMtime(remoteTarget, local.mtime);

        uploadedCount++;
      } catch (uploadErr) {
        failedCount++;
        this.logger.error(`[incremental-push] ${name}: 上传文件失败 ${local.relativePath}: ${uploadErr.message}`);
      } finally {
        progress.completeOneFile(local.relativePath);
      }
    });

    progress.finish();

    // ==========================================
    // 阶段三：清理多余文件 (可选)
    // ==========================================
    let deletedCount = 0;
    if (deleteRemoved) {
      const localRelSet = new Set(targetLocalFiles.map((f) => f.relativePath));
      const toDelete = remoteEntries.filter(
        (rf) => !rf.isDirectory && !localRelSet.has(toPosixPath(toRelativePath(rf.path, destination)))
      );

      await runConcurrentPool(toDelete, concurrency || 4, async (rf) => {
        try {
          await connector.deleteFile(rf.path);
          deletedCount++;
        } catch (err) {
          this.logger.warn(`[incremental-push] ${name}: 删除远程文件失败 ${rf.path}: ${err.message}`);
        }
      });
    }

    const totalDuration = formatDurationHMS(Date.now() - t0);
    this.logger.info(
      `[incremental-push] ${name}: 增量推送全部完成！总耗时: ${totalDuration}, 上传: ${uploadedCount}, 跳过: ${skippedCount}, 失败: ${failedCount}, 删除: ${deletedCount}`
    );
    return { uploadedCount, skippedCount, deletedCount, failedCount, duration: totalDuration };
  }
}

module.exports = { IncrementalPush };
