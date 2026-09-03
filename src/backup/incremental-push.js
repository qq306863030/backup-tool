'use strict';

const path = require('path');
const fs = require('fs');
const { needsSync, filterFiles } = require('../utils/file-compare');
const { toRelativePath, toPosixPath } = require('../utils/path');
const { LocalStorage } = require('../storage/local-storage');

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

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
    this.logger.info(`[incremental-push] ${task.name}: 正在扫描本地源目录 ${source}...`);
    const tLocal = Date.now();
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
    const totalLocalBytes = targetLocalFiles.reduce((sum, f) => sum + f.size, 0);
    this.logger.info(
      `[incremental-push] ${task.name}: 本地扫描完成，共 ${targetLocalFiles.length} 个文件（总计 ${formatBytes(totalLocalBytes)}，耗时 ${Date.now() - tLocal}ms）`
    );

    // 2. 远程清单：后台并发预取 + 按需惰性补充
    //    旧实现在此处 await 完整远程遍历（49GB 目录需数分钟）后才开始上传，
    //    改为后台预取并逐步按目录写入缓存，主线程立即开始上传；
    //    处理到某目录时若缓存尚未就绪，则自行 list 一次，保证永不阻塞。
    const remoteDirCache = new Map(); // remoteDir -> Map<fileName, {size, mtime}>
    const EMPTY_DIR_INDEX = new Map();
    let lazyListCount = 0; // 主线程因缓存未命中而主动 list 的目录数
    let remoteScanDone = false; // 后台遍历是否已产出完整缓存

    // 将一条远程条目写入「目录 -> 文件名」缓存
    const indexRemoteEntry = (entry) => {
      if (entry.isDirectory) return;
      const dir = path.posix.dirname(toPosixPath(entry.path));
      const base = path.posix.basename(entry.path);
      let map = remoteDirCache.get(dir);
      if (!map) {
        map = new Map();
        remoteDirCache.set(dir, map);
      }
      map.set(base, { size: entry.size, mtime: new Date(entry.mtime) });
    };

    const tRemote = Date.now();
    // 后台启动完整远程遍历（并发 BFS），结果边产出边填充缓存；此处故意不 await
    const remoteScanPromise = connector
      .listFiles(destination)
      .then((entries) => {
        const files = entries.filter((e) => !e.isDirectory);
        for (const e of files) indexRemoteEntry(e);
        remoteScanDone = true;
        this.logger.info(
          `[incremental-push] ${task.name}: 远程清单获取完成，共 ${files.length} 个文件（耗时 ${Date.now() - tRemote}ms，主线程另行补充 list ${lazyListCount} 个目录）`
        );
        return files;
      })
      .catch((err) => {
        // 远程目录不存在：视为空清单，缓存已是完整的，主循环无需再逐目录 list
        if (/no such file|not exist|ENOENT/i.test(err.message)) {
          remoteScanDone = true;
          this.logger.info(`[incremental-push] ${task.name}: 远程目录 ${destination} 不存在，按全新上传处理`);
          return [];
        }
        // 其他错误（网络等）：缓存不可信，主循环继续按需惰性 list
        this.logger.warn(`[incremental-push] ${task.name}: 后台获取远程清单失败，将按需逐目录查询: ${err.message}`);
        return [];
      });
    this.logger.info(`[incremental-push] ${task.name}: 已在后台启动远程清单获取，立即开始上传...`);

    // 按需获取某目录的远程文件索引：优先用后台预取结果，缺失时自行 list 一次
    const getRemoteDirIndex = async (remoteDir) => {
      const cached = remoteDirCache.get(remoteDir);
      if (cached) return cached;
      // 后台遍历已完成 → 缓存是完整的，未命中即远程不存在该目录，无需再问服务器
      if (remoteScanDone) return EMPTY_DIR_INDEX;
      if (typeof connector.listDir !== 'function') return EMPTY_DIR_INDEX;

      const fresh = new Map();
      for (const e of await connector.listDir(remoteDir)) {
        if (!e.isDirectory) fresh.set(e.name, { size: e.size, mtime: new Date(e.mtime) });
      }
      lazyListCount++;
      // await 期间后台可能已写入该目录，合并而非覆盖，避免丢条目
      const existing = remoteDirCache.get(remoteDir);
      if (existing) {
        for (const [k, v] of fresh) existing.set(k, v);
        return existing;
      }
      remoteDirCache.set(remoteDir, fresh);
      return fresh;
    };

    // 让出一次事件循环，给后台远程遍历填充缓存的机会。
    // 远程清单若很快就绪（小目录 / 目录不存在），主循环即可全程命中缓存、
    // 完全省掉逐目录 list；若尚未就绪，主循环仍会按需惰性 list，不会被阻塞。
    await new Promise((resolve) => setImmediate(resolve));

    let uploadedCount = 0;
    let skippedCount = 0;
    let deletedCount = 0;

    // 3. 遍历本地目标文件，对比并上传有变化或新增的文件
    let processed = 0;
    for (const local of targetLocalFiles) {
      const remoteTarget = toPosixPath(path.posix.join(toPosixPath(destination), local.relativePath));
      const remoteDir = path.posix.dirname(remoteTarget);
      const remoteName = path.posix.basename(remoteTarget);

      // 只查询该文件所在目录，而非整棵远程树
      const dirIndex = await getRemoteDirIndex(remoteDir);
      const remote = dirIndex.get(remoteName);

      if (needsSync(remote, local, compareBy)) {
        // 确保远程父目录存在（remoteDir 即远程目标文件的父目录）
        try {
          await connector.ensureRemoteDir(remoteDir);
        } catch (err) {
          this.logger.warn(`[incremental-push] ${task.name}: 创建远程目录失败 ${remoteDir}: ${err.message}`);
        }
        this.logger.info(`[incremental-push] ${task.name}: 上传 (${uploadedCount + 1}) ${local.relativePath} (${formatBytes(local.size)}) -> ${remoteTarget}`);
        await connector.uploadResume(local.fullPath, remoteTarget);
        // 上传后同步远程文件 mtime，确保下次增量比对能正确跳过
        await connector.setRemoteMtime(remoteTarget, local.mtime);
        uploadedCount++;
      } else {
        skippedCount++;
      }
      processed++;
      if (targetLocalFiles.length > 0 && processed % 50 === 0) {
        this.logger.info(`[incremental-push] ${task.name}: 已处理 ${processed}/${targetLocalFiles.length} (上传 ${uploadedCount}, 跳过 ${skippedCount})`);
      }
    }

    // 4. 等待后台远程遍历收尾（保证进程不会悬挂未完成的 promise），
    //    据此清理本地已不存在、远程仍残留的文件
    const remoteFiles = await remoteScanPromise;

    if (deleteRemoved) {
      const localRelSet = new Set(targetLocalFiles.map((f) => f.relativePath));
      for (const rf of remoteFiles) {
        const rel = toPosixPath(toRelativePath(rf.path, destination));
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
