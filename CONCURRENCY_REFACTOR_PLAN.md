# 🚀 文件比对与传输并发架构改造方案

## 一、 改造背景与目标

1. **核心目标**：
   - 实现**「先异步并发快速比对找出差异，再异步并发批量执行传输」**的两阶段架构（Two-Phase Pipeline）。
   - 在任务（Task）级别提供独立的并发调优能力：
     - `checkConcurrency`：控制**目录扫描与文件比对**阶段的并发数（默认 `8`）。
     - `concurrency`：控制**文件上传/下载执行**阶段的并发数（默认 `4`）。
   - 彻底废弃旧版分散在 `incremental.concurrency` 中的配置。
2. **技术路线（方案 A）**：
   - 基于 Node.js 异步事件循环与受控 Worker 异步并发池，在单 SSH 连接上复用 SFTP 通道与底层流式原语，避免 OS 线程开销与进程间通信成本。

---

## 二、 配置规范与数据适配改造

### 1. Task 配置标准结构
将并发控制统一收拢到任务顶层：

```json5
{
  "name": "sync-data",
  "direction": "push",          // "pull" 或 "push"
  "type": "incremental",        // "incremental" 或 "full"
  "cron": "0 2 * * *",
  "source": "./dist",
  "destination": "/var/www/html",

  // 🚀 新增顶层并发控制参数
  "checkConcurrency": 8,        // 比对并发数，默认 8
  "concurrency": 4,             // 传输并发数，默认 4

  "incremental": {
    "compareBy": ["size", "mtime"],
    "deleteRemoved": false,
    "include": [],
    "exclude": []
    // ❌ 彻底移除旧的 concurrency
  }
}
```

### 2. 默认值与适配器改造 (`src/config/adapter.js`)
```javascript
const DEFAULTS = {
  // ...
  task: {
    direction: 'pull',
    enabled: true,
    destination: DEFAULT_BACKUP_DIR,
    checkConcurrency: 8,  // 比对阶段默认并发 8
    concurrency: 4,       // 传输阶段默认并发 4
  },
  incremental: {
    compareBy: ['name', 'size', 'mtime'],
    deleteRemoved: false,
    include: [],
    exclude: []
    // 移除 concurrency
  }
};

function adaptTask(task, host) {
  // ... 校验 name, type, cron, source, destination 等 ...

  const adapted = {
    name: task.name,
    direction: task.direction || DEFAULTS.task.direction,
    enabled: task.enabled ?? DEFAULTS.task.enabled,
    type: task.type,
    cron: task.cron,
    source,
    destination,
    // 兼容与赋值
    checkConcurrency: parseInt(task.checkConcurrency ?? DEFAULTS.task.checkConcurrency, 10),
    concurrency: parseInt(task.concurrency ?? task.incremental?.concurrency ?? DEFAULTS.task.concurrency, 10),
  };

  if (task.type === 'incremental') {
    adapted.incremental = {
      compareBy: task.incremental?.compareBy ?? defaultCompareBy,
      deleteRemoved: task.incremental?.deleteRemoved ?? DEFAULTS.incremental.deleteRemoved,
      include: normalizeArray(task.incremental?.include),
      exclude: normalizeArray(task.incremental?.exclude),
    };
  }
  // ...
  return adapted;
}
```

### 3. Schema 校验改造 (`src/config/schema.js`)
```javascript
function validateTask(task, host) {
  // 校验 checkConcurrency 和 concurrency 是否为大于等于 1 的合法整数
  if (typeof task.checkConcurrency !== 'number' || task.checkConcurrency < 1) {
    throw new ConfigError(`任务 ${task.name} 的 checkConcurrency 必须是 >= 1 的正整数`);
  }
  if (typeof task.concurrency !== 'number' || task.concurrency < 1) {
    throw new ConfigError(`任务 ${task.name} 的 concurrency 必须是 >= 1 的正整数`);
  }
}
```

---

## 三、 CLI 交互式向导改造 (`bin/backup.js`)

在 `backup add task` 交互过程中添加并发配置项提示：

```javascript
// bin/backup.js -> cmdAddTask
// 在输入基础信息与增量/全量配置后：

console.log('\n并发性能配置:');
const checkConcurrencyStr = await prompt('文件比对并发数 (默认 8): ') || '8';
const checkConcurrency = parseInt(checkConcurrencyStr, 10);

const concurrencyStr = await prompt('传输执行并发数 (默认 4): ') || '4';
const concurrency = parseInt(concurrencyStr, 10);

const taskConfig = {
  name: taskName,
  direction,
  type,
  cron,
  source,
  destination,
  checkConcurrency,
  concurrency,
  // 增量/全量特定字段...
};
```

---

## 四、 核心引擎改造：两阶段并发管道（伪代码与设计）

### 1. 通用并发 Worker 执行器 (`src/utils/concurrent-pool.js`)
抽离可复用的受控异步任务池：

```javascript
/**
 * 受控并发 Worker 队列
 * @param {Array<T>} items 待处理任务数组
 * @param {number} concurrency 并发数
 * @param {Function} taskFn 处理单个任务的异步函数 (item, index) => Promise<void>
 */
async function runConcurrentPool(items, concurrency, taskFn) {
  if (!items || items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await taskFn(items[idx], idx);
    }
  });

  await Promise.all(workers);
}
```

---

### 2. 增量推送引擎改造 (`src/backup/incremental-push.js`)

将过去的“边扫描边上传”重构为**两阶段严格解耦流水线**：

```javascript
class IncrementalPush {
  async run(connector, task) {
    const { name, source, destination, checkConcurrency, concurrency, incremental } = task;
    const { compareBy, deleteRemoved, include, exclude } = incremental;

    this.logger.info(`[incremental-push] ${name}: 开始增量推送比对... (比对并发: ${checkConcurrency})`);

    // ==========================================
    // 阶段一：快速比对（本地扫描 + 远程并发 BFS 扫描）
    // ==========================================
    const t0 = Date.now();
    const [allLocalRelPaths, remoteEntries] = await Promise.all([
      this.storage.listFiles(source),
      connector.listFiles(destination, checkConcurrency) // 传入任务的 checkConcurrency
    ]);

    // 1. 过滤本地文件
    const filteredRelPaths = new Set(filterFiles(allLocalRelPaths, include, exclude));
    const targetLocalFiles = allLocalRelPaths
      .filter(rel => filteredRelPaths.has(rel))
      .map(rel => {
        const full = path.resolve(source, rel);
        const stat = fs.statSync(full);
        return { relativePath: toPosixPath(rel), fullPath: full, size: stat.size, mtime: stat.mtime };
      });

    // 2. 构建远程 Map 索引 (O(1) 查找)
    const remoteMap = new Map(); // posixRelPath -> { size, mtime, path }
    for (const entry of remoteEntries) {
      if (!entry.isDirectory) {
        const rel = toPosixPath(toRelativePath(entry.path, destination));
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
    const progress = createAggregatedProgress(totalUploadBytes, toUpload.length);

    await runConcurrentPool(toUpload, concurrency, async (local) => {
      const remoteTarget = toPosixPath(path.posix.join(toPosixPath(destination), local.relativePath));
      const remoteDir = path.posix.dirname(remoteTarget);

      // 确保远程目录存在
      await connector.ensureRemoteDir(remoteDir);

      // 执行流式上传
      await connector.uploadResume(local.fullPath, remoteTarget, (chunkBytes) => {
        progress.addBytes(chunkBytes);
      });

      // 同步远程 mtime
      await connector.setRemoteMtime(remoteTarget, local.mtime);

      uploadedCount++;
      progress.completeOneFile(local.relativePath);
    });

    progress.finish();

    // ==========================================
    // 阶段三：清理多余文件 (可选)
    // ==========================================
    let deletedCount = 0;
    if (deleteRemoved) {
      const localRelSet = new Set(targetLocalFiles.map(f => f.relativePath));
      const toDelete = remoteEntries.filter(rf => !rf.isDirectory && !localRelSet.has(toPosixPath(toRelativePath(rf.path, destination))));

      await runConcurrentPool(toDelete, concurrency, async (rf) => {
        await connector.deleteFile(rf.path);
        deletedCount++;
      });
    }

    this.logger.info(`[incremental-push] ${name}: 增量推送全部完成！上传: ${uploadedCount}, 跳过: ${skippedCount}, 删除: ${deletedCount}`);
    return { uploadedCount, skippedCount, deletedCount };
  }
}
```

---

### 3. 增量拉取引擎改造 (`src/backup/incremental.js`)

```javascript
class IncrementalBackup {
  async run(connector, task) {
    const { name, source, destination, checkConcurrency, concurrency, incremental } = task;
    const { compareBy, deleteRemoved, include, exclude } = incremental;

    // 阶段一：远程并发扫描比对
    const remoteFiles = await connector.listFiles(source, checkConcurrency);
    const remoteFileEntries = remoteFiles.filter(f => !f.isDirectory);

    const relPaths = remoteFileEntries.map(f => toRelativePath(f.path, source));
    const filteredSet = new Set(filterFiles(relPaths, include, exclude));

    const toDownload = [];
    let skippedCount = 0;
    let totalDownloadBytes = 0;

    for (const entry of remoteFileEntries) {
      const rel = toRelativePath(entry.path, source);
      if (!filteredSet.has(rel)) continue;

      const localPath = safeJoin(destination, rel);
      const localStat = this.storage.stat(localPath);
      if (needsSync(entry, localStat, compareBy)) {
        toDownload.push({ entry, rel, localPath });
        totalDownloadBytes += entry.size;
      } else {
        skippedCount++;
      }
    }

    this.logger.info(`[incremental] ${name}: 发现 ${toDownload.length} 个文件待下载（${formatBytes(totalDownloadBytes)}），跳过 ${skippedCount} 个`);

    // 阶段二：受控并发下载
    let downloadedCount = 0;
    await runConcurrentPool(toDownload, concurrency, async (job) => {
      this.storage.ensureDir(path.dirname(job.localPath));
      // 调用断点续传下载流
      await connector.downloadResume(job.entry.path, job.localPath, job.entry.mtime);
      downloadedCount++;
    });

    // 阶段三：清理本地已删除文件
    let removedCount = 0;
    if (deleteRemoved) {
      removedCount = this.removeDeleted(destination, filteredSet);
    }

    return { downloaded: downloadedCount, skipped: skippedCount, removed: removedCount };
  }
}
```

---

### 4. 全量拉取/推送引擎改造 (`full.js` / `full-push.js`)
* **全量拉取 (`full.js`)**：使用 `checkConcurrency` 进行 `listFiles` 扫描；下载阶段由原本的串行 `for...await` 升级为 `concurrency` 并发 Worker 下载。
* **全量推送 (`full-push.js`)**：
  - 非压缩模式：使用 `concurrency` 并发 Worker 批量上传文件。
  - 压缩模式：打包单 `.zip` 上传（保持单文件传输）。

---

## 五、 并发下的聚合进度管理器 (`createAggregatedProgress`)

当多个文件并发上传时，单文件覆盖输出（`\r`）会相互交错错乱。设计一个**全局聚合进度条**：

```javascript
function createAggregatedProgress(totalBytes, totalFiles) {
  let transferredBytes = 0;
  let finishedFiles = 0;
  let lastTick = 0;
  let lastLen = 0;

  return {
    addBytes(delta) {
      transferredBytes += delta;
      this.render();
    },
    completeOneFile(fileName) {
      finishedFiles++;
      this.render();
    },
    render() {
      const now = Date.now();
      if (now - lastTick < 100) return; // 100ms 节流
      lastTick = now;

      const pct = totalBytes > 0 ? Math.min(100, (transferredBytes / totalBytes) * 100) : 100;
      const text = `传输进度: [${finishedFiles}/${totalFiles} 文件] ${formatBytes(transferredBytes)}/${formatBytes(totalBytes)} (${pct.toFixed(1)}%)`;
      process.stdout.write('\r' + ' '.repeat(lastLen) + '\r' + text);
      lastLen = text.length;
    },
    finish() {
      if (lastLen > 0) {
        process.stdout.write('\r' + ' '.repeat(lastLen) + '\r');
      }
    }
  };
}
```

---

## 六、 涉及文件修改清单

| 文件路径 | 变更说明 |
| :--- | :--- |
| `src/config/adapter.js` | 更新 `DEFAULTS`，移除 `incremental.concurrency`，添加任务级 `checkConcurrency (8)` 和 `concurrency (4)` 适配 |
| `src/config/schema.js` | 增加对 `checkConcurrency` 和 `concurrency` 正整数校验 |
| `bin/backup.js` | 在 `backup add task` 交互向导中添加并发配置输入与保存 |
| `src/utils/concurrent-pool.js` *(新增/复用)* | 封装通用的受控异步任务并发执行池 |
| `src/connectors/sftp.js` | 确保 `listFiles(remotePath, checkConcurrency)` 将比对并发数正确传递给 `listDirectory` |
| `src/backup/incremental-push.js` | 重构为「并发比对 $\rightarrow$ 并发上传」两阶段流水线 |
| `src/backup/incremental.js` | 升级为受控并发批量下载 |
| `src/backup/full.js` / `full-push.js` | 升级文件传输阶段为并发上传/下载 |
| `README.md` / `README.en.md` | 更新配置示例与文档说明 |
