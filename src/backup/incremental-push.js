'use strict';

const path = require('path');
const fs = require('fs');
const { needsSync, filterFiles } = require('../utils/file-compare');
const { toRelativePath, toPosixPath } = require('../utils/path');
const { LocalStorage } = require('../storage/local-storage');

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
   * @param {import('../connectors/sftp')} connector
   * @param {Object} task
   */
  async run(connector, task) {
    const { source, destination, incremental } = task;
    const { compareBy, deleteRemoved, include, exclude } = incremental;

    this.logger.info(`[incremental-push] ${task.name}: 开始增量推送 ${source} -> ${destination}`);

    // 1. 获取本地文件列表（含 stat 信息）
    const allLocalRelPaths = this.storage.listFiles(source);
    const allLocalFiles = allLocalRelPaths.map((rel) => {
      const full = path.resolve(source, rel);
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
        relativePath: toPosixPath(rel),
        fullPath: full,
        size,
        mtime,
      };
    });

    // 根据 include/exclude 过滤
    const filteredRelPaths = new Set(filterFiles(allLocalFiles.map((f) => f.relativePath), include, exclude));
    const targetLocalFiles = allLocalFiles.filter((f) => filteredRelPaths.has(f.relativePath));

    // 2. 获取远程文件列表 (connector.listFiles 返回 {name, path, size, mtime, isDirectory})
    let remoteFiles = [];
    try {
      const entries = await connector.listFiles(destination);
      remoteFiles = entries.filter((e) => !e.isDirectory);
    } catch (err) {
      this.logger.warn(`[incremental-push] ${task.name}: 获取远程目录失败，可能尚未创建: ${err.message}`);
    }

    // 构建远程文件索引 (以相对路径为 key)
    const remoteFileMap = new Map();
    for (const rf of remoteFiles) {
      const rel = toPosixPath(toRelativePath(rf.path, destination));
      remoteFileMap.set(rel, { size: rf.size, mtime: new Date(rf.mtime) });
    }

    let uploadedCount = 0;
    let skippedCount = 0;
    let deletedCount = 0;

    // 3. 遍历本地目标文件，对比并上传有变化或新增的文件
    for (const local of targetLocalFiles) {
      const remote = remoteFileMap.get(local.relativePath);
      const remoteTarget = toPosixPath(path.posix.join(toPosixPath(destination), local.relativePath));

      if (needsSync(remote, local, compareBy)) {
        // 确保远程父目录存在
        const remoteParentDir = toPosixPath(path.posix.dirname(remoteTarget));
        try {
          await connector.ensureRemoteDir(remoteParentDir);
        } catch (err) {
          this.logger.warn(`[incremental-push] ${task.name}: 创建远程目录失败 ${remoteParentDir}: ${err.message}`);
        }
        this.logger.info(`[incremental-push] ${task.name}: 上传 ${local.relativePath} -> ${remoteTarget}`);
        await connector.uploadResume(local.fullPath, remoteTarget);
        // 上传后同步远程文件 mtime，确保下次增量比对能正确跳过
        await connector.setRemoteMtime(remoteTarget, local.mtime);
        uploadedCount++;
      } else {
        skippedCount++;
      }
    }

    // 4. 处理远程已被删除但在本地已不存在的文件 (如果开启了 deleteRemoved)
    if (deleteRemoved) {
      const localRelSet = new Set(targetLocalFiles.map((f) => f.relativePath));
      for (const [rel] of remoteFileMap.entries()) {
        if (!localRelSet.has(rel)) {
          const remoteTarget = toPosixPath(path.posix.join(toPosixPath(destination), rel));
          this.logger.info(`[incremental-push] ${task.name}: 删除远程多余文件 ${remoteTarget}`);
          try {
            await connector.deleteFile(remoteTarget);
            deletedCount++;
          } catch (err) {
            this.logger.warn(`[incremental-push] ${task.name}: 删除远程文件失败 ${remoteTarget}: ${err.message}`);
          }
        }
      }
    }

    this.logger.info(
      `[incremental-push] ${task.name}: 增量推送完成, 上传: ${uploadedCount}, 跳过: ${skippedCount}, 删除: ${deletedCount}`
    );

    return { uploadedCount, skippedCount, deletedCount };
  }
}

module.exports = { IncrementalPush };
