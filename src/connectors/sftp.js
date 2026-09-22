'use strict';

const fs = require('fs');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');
const readline = require('readline');
const { ConnectionError } = require('../errors');
const { getLogger } = require('../utils/logger');

/** 格式化字节数为人类可读 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 续传时的「保序并发写」流水线深度（默认值，可由 server.pipeConcurrency 覆盖） */
const DEFAULT_PIPE_CONCURRENCY = 8;
/** 单次 write 请求的块大小 */
const WRITE_CHUNK_SIZE = 64 * 1024;
/**
 * 断线后自动重连并续传的最大尝试次数
 * 续传每次都能累积远程进度，故可比 server.retry.max 放宽
 */
const RESUME_MAX_ATTEMPTS = 10;
/** 重连退避的基数与上限（毫秒），避免断网时高频重连 */
const RECONNECT_BACKOFF_BASE_MS = 1000;
const RECONNECT_BACKOFF_MAX_MS = 30000;
/** 关闭连接的最长等待时间（毫秒），超时则强制销毁底层 socket */
const CLOSE_TIMEOUT_MS = 3000;

/**
 * SFTP 连接器：封装 ssh2-sftp-client
 * 统一接口：connect / listFiles / download / close
 */
class SftpConnector {
  /**
   * @param {object} server 内部标准服务器配置
   */
  constructor(server) {
    this.server = server;
    this.client = this._createSftpClient();
    this.connected = false;
    this._reconnectPromise = null;
    this._ensuredRemoteDirs = new Set();
    this._mkdirLock = null;
  }

  /**
   * 创建带有统一事件日志的 SftpClient 实例
   * @private
   */
  _createSftpClient() {
    return new SftpClient('sftp', {
      error: (err) => {
        const log = getLogger();
        log.warn(`[sftp] 底层 SSH/SFTP 事件: ${err.message}`);
      },
      end: () => {},
      close: () => {},
    });
  }

  /**
   * 判断错误是否为连接断开/网络重置相关
   *
   * ⚠️ 关键点：ssh2 在 socket 关闭时会把**所有挂起的请求回调**统一抛出
   * `Error('No response from server')`（见 ssh2 `lib/client.js` 与
   * `lib/protocol/SFTP.js` 的 cleanupRequests）。大文件长时间传输时，
   * 网络抖动/对端强制断开会表现为 write ECONNRESET + No response from server，
   * 若不把它判定为连接错误，断点续传分支永远不会触发，整个任务就会直接失败。
   * @param {Error} err
   * @returns {boolean}
   */
  isConnectionError(err) {
    if (!err) return false;
    const cause = err.cause;
    const msg = [
      err.message,
      err.code,
      err.name,
      err.description,
      err.level, // ssh2 会附加 'client-socket' / 'client-timeout'
      cause && cause.message,
      cause && cause.code,
      cause && cause.level,
    ]
      .filter((v) => typeof v === 'string' && v.length > 0)
      .join(' ');
    return /keepalive|no response from server|ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EPIPE|ENOTCONN|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|socket hang up|connection (lost|reset|closed)|closed|Not connected|No SFTP connection|client is not connected|Channel closed|Socket closed|Handshake failed|client-socket|client-timeout/i.test(
      msg
    );
  }

  /**
   * 重新建立连接（互斥防并发重复重连）
   * @returns {Promise<void>}
   */
  async reconnect() {
    if (this._reconnectPromise) {
      return this._reconnectPromise;
    }
    this._reconnectPromise = (async () => {
      const log = getLogger();
      log.warn(`[sftp] 检测到网络连接断开，正在自动重新连接 ${this.server.host}:${this.server.port}...`);
      await this._destroyClient();
      this.client = this._createSftpClient();
      this.connected = false;
      this._ensuredRemoteDirs = new Set();
      this._mkdirLock = null;
      await this.connect();
      log.info(`[sftp] 自动重新连接成功！继续执行未完成的传输...`);
    })().finally(() => {
      this._reconnectPromise = null;
    });
    return this._reconnectPromise;
  }

  /**
   * 关闭并销毁当前底层连接（带超时保护）
   * 半开连接上调用 end() 可能永远不返回（end() 依赖 close 事件），
   * 因此超时后直接销毁底层 socket，避免重连流程被卡死、进程无法退出。
   * @private
   * @returns {Promise<void>}
   */
  async _destroyClient() {
    const client = this.client;
    this.connected = false;
    if (!client) return;
    let timer = null;
    try {
      await Promise.race([
        Promise.resolve().then(() => client.end()),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('关闭 SFTP 连接超时')), CLOSE_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      const ssh = client.client;
      if (ssh && typeof ssh.destroy === 'function') {
        try {
          ssh.destroy();
        } catch (_) {}
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 确保连接处于可用状态
   * @returns {Promise<void>}
   */
  async ensureConnected() {
    if (!this.connected || !this.client || !this.client.sftp) {
      await this.reconnect();
    }
  }

  /**
   * 建立连接
   * @returns {Promise<void>}
   */
  async connect() {
    const { host, port, username, auth, connectTimeout, retry } = this.server;
    const config = {
      host,
      port,
      username,
      connectTimeout,
      readyTimeout: connectTimeout,
      keepaliveInterval: 15000, // 每 15 秒发送一次 SSH 保活心跳（降低心跳频率，避免大文件上传时占满队列）
      keepaliveCountMax: 10,    // 连续 10 次未收到响应才视为超时断开（给予 150 秒高拥塞与大文件写盘缓冲）
    };

    if (auth.type === 'password') {
      config.password = auth.password;
    } else {
      config.privateKey = fs.readFileSync(auth.privateKeyPath, 'utf8');
      if (auth.passphrase) config.passphrase = auth.passphrase;
    }

    const log = getLogger();
    log.info(`[sftp] 正在连接 ${username}@${host}:${port}（超时 ${connectTimeout}ms）...`);

    let lastErr = null;
    for (let attempt = 1; attempt <= retry.max; attempt++) {
      try {
        const t0 = Date.now();
        await this.client.connect(config);
        this.connected = true;
        log.info(`[sftp] 连接成功 ${host}:${port}（耗时 ${Date.now() - t0}ms）`);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < retry.max) {
          log.warn(`[sftp] 连接失败（${attempt}/${retry.max}）: ${err.message}，${retry.delay}ms 后重试...`);
          await sleep(retry.delay);
        }
      }
    }
    throw new ConnectionError(`连接 SFTP 失败 ${host}:${port}: ${lastErr.message}`, lastErr);
  }

  /**
   * 通过 SSH Exec 执行 find 命令流式获取远程所有文件元数据（单次 RTT，毫秒级扫描数十万文件）
   * @param {string} remotePath 远程路径
   * @param {object} log logger 实例
   * @returns {Promise<Array<{name, path, size, mtime, isDirectory}>>}
   */
  async listFilesByFind(remotePath, log) {
    const sshClient = this.client && this.client.client;
    if (!sshClient || typeof sshClient.exec !== 'function') {
      throw new Error('底层 SSH Exec 客户端不可用');
    }

    const normalizedRemote = remotePath.replace(/\/+$/, '');
    const escapedPath = normalizedRemote.replace(/'/g, "'\\''");
    // Linux find 命令输出: <完整路径>\t<大小字节>\t<mtime小数秒>\t<类型>\n
    const cmd = `find '${escapedPath}' -printf '%p\\t%s\\t%T@\\t%y\\n'`;

    return new Promise((resolve, reject) => {
      let isSettled = false;
      let idleTimer = null;

      // 动态数据静默超时：连续 30 秒未收到任何一行数据才视为挂死
      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (!isSettled) {
            isSettled = true;
            reject(new Error('SSH find 数据接收静默超时（连续 30 秒无新数据）'));
          }
        }, 30000);
      };

      resetIdleTimer();

      sshClient.exec(cmd, (err, stream) => {
        if (err) {
          if (idleTimer) clearTimeout(idleTimer);
          isSettled = true;
          return reject(err);
        }

        const result = [];
        let stderr = '';
        let lastProgressAt = Date.now();
        const t0 = Date.now();
        const rl = readline.createInterface({ input: stream });

        rl.on('line', (line) => {
          if (isSettled) return;
          resetIdleTimer(); // 只要有数据持续流入，重置静默超时

          if (!line) return;
          const parts = line.split('\t');
          if (parts.length >= 4) {
            const fullPath = parts[0];
            // 排除与查询路径自身完全一致的根目录条目
            if (fullPath === normalizedRemote && parts[3] === 'd') {
              return;
            }
            const size = parseInt(parts[1], 10) || 0;
            const mtimeSeconds = parseFloat(parts[2]);
            const mtimeMs = Number.isNaN(mtimeSeconds) ? 0 : Math.floor(mtimeSeconds * 1000);
            const isDirectory = parts[3] === 'd';
            result.push({
              name: path.posix.basename(fullPath),
              path: fullPath,
              size,
              mtime: isDirectory ? 0 : mtimeMs,
              isDirectory,
            });

            // 每 3 秒或每 10000 条输出一次进度日志
            const now = Date.now();
            if (now - lastProgressAt >= 3000 || result.length % 10000 === 0) {
              lastProgressAt = now;
              log.info(
                `[sftp] 远程 find 接收中: 已发现 ${result.length} 项（耗时 ${((now - t0) / 1000).toFixed(1)}s）`
              );
            }
          }
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString('utf8');
        });

        const finish = (code) => {
          if (isSettled) return;
          isSettled = true;
          if (idleTimer) clearTimeout(idleTimer);
          rl.close();

          if (code !== 0 && result.length === 0) {
            return reject(new Error(stderr.trim() || `find 命令退出异常 (code ${code})`));
          }
          resolve(result);
        };

        stream.on('close', finish);
        stream.on('end', () => finish(0));
        stream.on('error', (e) => {
          if (!isSettled) {
            isSettled = true;
            if (idleTimer) clearTimeout(idleTimer);
            rl.close();
            reject(e);
          }
        });
      });
    });
  }

  /**
   * 列出路径下的文件（支持文件或目录，目录递归）
   * 优先使用 SSH 远程 find 极速流式扫描，若环境不支持则自动降级为 SFTP BFS 遍历
   * @param {string} remotePath 远程路径（文件或目录）
   * @param {number} [concurrency=8] 目录并发扫描数（回退模式下使用）
   * @returns {Promise<Array<{name, path, size, mtime, isDirectory}>>}
   */
  async listFiles(remotePath, concurrency = 8) {
    const log = getLogger();
    log.info(`[sftp] 正在列出远程路径 ${remotePath}...`);
    const t0 = Date.now();
    try {
      // 1. 优先尝试 SSH find 极速流式扫描（单次网络往返，毫秒级扫描十万+文件）
      try {
        const findResult = await this.listFilesByFind(remotePath, log);
        log.info(
          `[sftp] 远程 find 扫描全部完成 ${remotePath}（共 ${findResult.length} 项，耗时 ${Date.now() - t0}ms）`
        );
        return findResult;
      } catch (findErr) {
        log.warn(`[sftp] SSH find 极速通道未完成 (${findErr.message})，回退到 SFTP 并发遍历...`);
      }

      // 2. 回退模式：SFTP BFS 遍历
      const stat = await this.client.stat(remotePath);
      if (!stat.isDirectory) {
        // 单个文件
        log.info(`[sftp] 列出完成 ${remotePath}（单个文件，耗时 ${Date.now() - t0}ms）`);
        return [{
          name: path.basename(remotePath),
          path: remotePath,
          size: stat.size,
          mtime: stat.modifyTime,
          isDirectory: false,
        }];
      }
      const result = await this.listDirectory(remotePath, log, concurrency);
      log.info(`[sftp] 列出完成 ${remotePath}（共 ${result.length} 项，耗时 ${Date.now() - t0}ms）`);
      return result;
    } catch (err) {
      log.warn(`[sftp] 列出远程路径失败 ${remotePath}: ${err.message}`);
      throw new ConnectionError(`列出远程路径失败 ${remotePath}: ${err.message}`, err);
    }
  }

  /**
   * 并发递归列出目录下的所有文件（BFS + 并发限制）
   * 远程大目录遍历时串行递归极慢，改为广度优先 + 并发，吞吐量提升数倍
   * @param {string} remotePath 远程目录
   * @param {object} [log] logger 实例（可选）
   * @param {number} [concurrency=8] 同一时刻最多并发多少个 list 请求。
   *   取值偏高会与同连接上的上传/下载争抢 SSH 通道，8 在吞吐与稳定性间较平衡
   * @returns {Promise<Array<{name, path, size, mtime, isDirectory}>>}
   */
  async listDirectory(remotePath, log, concurrency = 8) {
    const logger = log || getLogger();
    const result = [];
    // 待处理的子目录队列
    const pendingDirs = [remotePath];
    let listedDirs = 0;
    let lastProgressAt = 0;
    const t0 = Date.now();

    // 限制并发的 worker 池
    const workers = Array.from({ length: concurrency }, () => (async () => {
      while (true) {
        const dir = pendingDirs.shift();
        if (!dir) break;
        let items;
        try {
          items = await this.client.list(dir);
        } catch (err) {
          logger.warn(`[sftp] 列出子目录失败 ${dir}: ${err.message}`);
          continue;
        }
        listedDirs++;
        const dirChildren = [];
        for (const item of items) {
          const fullPath = `${dir.replace(/\/+$/, '')}/${item.name}`;
          const entry = {
            name: item.name,
            path: fullPath,
            size: item.size,
            mtime: item.modifyTime,
            isDirectory: item.type === 'd',
          };
          result.push(entry);
          if (item.type === 'd') {
            dirChildren.push(fullPath);
          }
        }
        // 子目录入队（保证并发安全：push 到同一数组末尾即可）
        for (const sub of dirChildren) pendingDirs.push(sub);

        // 每 5 秒打印一次进度，避免大目录长时间静默
        const now = Date.now();
        if (now - lastProgressAt >= 5000) {
          lastProgressAt = now;
          logger.info(
            `[sftp] 列出进度: 已展开 ${listedDirs} 个目录，发现 ${result.length} 项，剩余队列 ${pendingDirs.length}（耗时 ${((now - t0) / 1000).toFixed(1)}s）`
          );
        }
      }
    })());

    await Promise.all(workers);
    return result;
  }

  /**
   * 列出单个目录的直接子项（非递归）
   * 目录不存在或不可读时返回空数组而不抛错，便于调用方按需惰性拉取
   * @param {string} remotePath 远程目录
   * @returns {Promise<Array<{name, path, size, mtime, isDirectory}>>}
   */
  async listDir(remotePath) {
    try {
      const items = await this.client.list(remotePath);
      return items.map((item) => ({
        name: item.name,
        path: `${remotePath.replace(/\/+$/, '')}/${item.name}`,
        size: item.size,
        mtime: item.modifyTime,
        isDirectory: item.type === 'd',
      }));
    } catch (err) {
      // 目录不存在 / 无权限：视为空目录，不中断上层流程
      return [];
    }
  }

  /**
   * 下载单个文件
   * @param {string} remotePath 远程文件路径
   * @param {string} localPath 本地文件路径
   * @param {number|Date} [mtime] 远程文件修改时间，下载后设置到本地文件
   * @returns {Promise<void>}
   */
  async download(remotePath, localPath, mtime) {
    try {
      await this.client.fastGet(remotePath, localPath);
      // 保留远程文件的修改时间，使增量备份能正确跳过未变化的文件
      if (mtime) {
        const ts = new Date(mtime).getTime();
        if (!Number.isNaN(ts)) {
          fs.utimesSync(localPath, new Date(), new Date(ts));
        }
      }
    } catch (err) {
      throw new ConnectionError(`下载文件失败 ${remotePath}: ${err.message}`, err);
    }
  }

  /**
   * 上传单个文件
   * @param {string} localPath 本地文件路径
   * @param {string} remotePath 远程文件路径
   * @returns {Promise<void>}
   */
  async uploadFile(localPath, remotePath) {
    try {
      await this.client.fastPut(localPath, remotePath);
    } catch (err) {
      throw new ConnectionError(`上传文件失败 ${localPath}: ${err.message}`, err);
    }
  }

  /**
   * 断点续传下载单个文件
   * 本地已有部分数据时从断点继续，完成后保持远程 mtime
   * @param {string} remotePath 远程文件路径
   * @param {string} localPath 本地文件路径
   * @param {number|Date} [mtime] 远程修改时间，下载后设置到本地文件
   * @param {Function} [onProgress] (transferred, total) => void 进度回调
   * @param {number} [attempt=1] 当前重试次数
   * @returns {Promise<{status: string, transferred: number, total: number}>}
   *          status: completed（完整下载）/ resumed（续传）/ skipped（已存在跳过）
   */
  async downloadResume(remotePath, localPath, mtime, onProgress, attempt = 1) {
    const maxAttempts = Math.max(this.server?.retry?.max || 3, RESUME_MAX_ATTEMPTS);
    try {
      await this.ensureConnected();

      let total = 0;
      try {
        const stat = await this.client.stat(remotePath);
        total = stat.size;
      } catch (err) {
        throw new ConnectionError(`获取远程文件信息失败 ${remotePath}: ${err.message}`, err);
      }

      let localSize = 0;
      if (fs.existsSync(localPath)) {
        localSize = fs.statSync(localPath).size;
      }
      fs.mkdirSync(path.dirname(localPath), { recursive: true });

      // 本地大小已达到远程大小，视为已完成
      if (localSize >= total) {
        this.setMtime(localPath, mtime);
        return { status: 'skipped', transferred: total, total };
      }

      let transferred = localSize;
      let rs;
      try {
        // 从本地已有大小（断点）开始读取远程文件
        rs = this.client.createReadStream(remotePath, { start: localSize });
      } catch (err) {
        throw new ConnectionError(`打开远程文件失败 ${remotePath}: ${err.message}`, err);
      }
      // 追加模式写入本地，保留已有部分
      const ws = fs.createWriteStream(localPath, { flags: 'a' });

      try {
        await new Promise((resolve, reject) => {
          rs.on('data', (chunk) => {
            transferred += chunk.length;
            if (onProgress) onProgress(transferred, total);
          });
          rs.on('error', (err) => reject(new ConnectionError(`下载文件失败 ${remotePath}: ${err.message}`, err)));
          ws.on('error', (err) => reject(new ConnectionError(`写入本地文件失败 ${localPath}: ${err.message}`, err)));
          ws.on('finish', resolve);
          rs.pipe(ws);
        });
      } finally {
        // 断线时 pipe 不会自动销毁对端流，需显式释放，避免句柄泄漏
        if (!rs.destroyed) rs.destroy();
        if (!ws.destroyed) ws.destroy();
      }

      this.setMtime(localPath, mtime);
      return { status: localSize > 0 ? 'resumed' : 'completed', transferred: total, total };
    } catch (err) {
      if (this.isConnectionError(err) && attempt < maxAttempts) {
        const log = getLogger();
        const delay = Math.min(RECONNECT_BACKOFF_BASE_MS * 2 ** (attempt - 1), RECONNECT_BACKOFF_MAX_MS);
        log.warn(
          `[sftp] 下载连接断开 (${err.message})，${delay}ms 后自动重连并断点续传 (${attempt}/${maxAttempts})...`
        );
        await sleep(delay);
        try {
          await this.reconnect();
        } catch (reconnectErr) {
          log.warn(`[sftp] 自动重连失败: ${reconnectErr.message}`);
        }
        return this.downloadResume(remotePath, localPath, mtime, onProgress, attempt + 1);
      }
      throw err instanceof ConnectionError ? err : new ConnectionError(`下载文件失败 ${remotePath}: ${err.message}`, err);
    }
  }

  /**
   * 断点续传上传单个文件
   * 远程已有部分数据时从断点继续（以追加模式写入末尾）
   *
   * 吞吐说明：SFTP 单条 write 请求需要等待一次网络往返，逐块串行写入时
   * 实际速率被 RTT 锁死（64KB / 60ms ≈ 1MB/s）。这里改为「保序并发写」：
   * 按块顺序提交最多 pipeConcurrency 个写请求，服务端（OpenSSH sftp-server）
   * 顺序处理同一句柄的请求并按到达顺序追加，数据顺序依旧正确，
   * 但吞吐可提升数倍，显著缩短超长传输暴露在弱网下的时间窗口。
   *
   * @param {string} localPath 本地文件路径
   * @param {string} remotePath 远程文件路径
   * @param {Function} [onProgress] (transferred, total) => void 进度回调，transferred 为含续传起点的累计值
   * @param {number} [attempt=1] 当前重试次数
   * @returns {Promise<{status: string, transferred: number, total: number}>}
   *          status: completed（完整上传）/ resumed（续传）/ skipped（已存在跳过）
   */
  async uploadResume(localPath, remotePath, onProgress, attempt = 1) {
    const maxAttempts = Math.max(this.server?.retry?.max || 3, RESUME_MAX_ATTEMPTS);
    const total = fs.statSync(localPath).size;

    try {
      await this.ensureConnected();

      let remoteSize = 0;
      try {
        const stat = await this.client.stat(remotePath);
        remoteSize = stat.size;
      } catch (err) {
        remoteSize = 0; // 远程文件不存在
      }

      // 远程大小已达到本地大小，视为已完成
      if (remoteSize >= total) {
        return { status: 'skipped', transferred: total, total };
      }

      const log = getLogger();
      const baseName = path.basename(localPath);
      const t0 = Date.now();
      const remoteLabel = remoteSize > 0 ? `断点续传（已传 ${formatBytes(remoteSize)}）` : '新文件上传';
      log.info(`[sftp] 上传 ${remoteLabel}: ${baseName} (本地 ${formatBytes(total)}) -> ${remotePath}`);

      // 使用底层 SFTP 原语：以追加模式（SSH_FXF_APPEND）打开远程文件，
      // 写入时数据始终落在文件末尾，从而实现断点续传
      const sftp = this.client.sftp;
      const handle = await this._openRemoteAppend(sftp, remotePath);

      let lastProgressAt = Date.now();
      let written = 0;
      try {
        written = await this._writeLocalToRemote(sftp, handle, localPath, remoteSize, (bytesWritten) => {
          if (onProgress) onProgress(remoteSize + bytesWritten, total);

          // 大文件每 5 秒打印一次进度日志，便于观察是否真的在传
          const now = Date.now();
          if (now - lastProgressAt >= 5000) {
            lastProgressAt = now;
            const transferred = remoteSize + bytesWritten;
            const pct = ((transferred / total) * 100).toFixed(1);
            // 速率只按「本轮实际写入量」计算，避免把续传起点算进去造成虚假高速
            const rate = bytesWritten / ((now - t0) / 1000);
            log.info(
              `[sftp] ${baseName} 上传进度: ${formatBytes(transferred)}/${formatBytes(total)} (${pct}%)` +
              ` 本轮已写入 ${formatBytes(bytesWritten)}，速率 ${formatBytes(rate)}/s`
            );
          }
        });
      } finally {
        // 用捕获的 sftp 对象关闭句柄，避免重连后误关新连接上的句柄
        if (handle) {
          try {
            await new Promise((resolve) => sftp.close(handle, () => resolve()));
          } catch (_) {}
        }
      }

      const duration = Date.now() - t0;
      log.info(
        `[sftp] 上传完成 ${baseName}: ${formatBytes(remoteSize + written)}/${formatBytes(total)}` +
        `（本轮写入 ${formatBytes(written)}，耗时 ${duration}ms）`
      );
      return { status: remoteSize > 0 ? 'resumed' : 'completed', transferred: total, total };
    } catch (err) {
      if (this.isConnectionError(err) && attempt < maxAttempts) {
        const log = getLogger();
        const delay = Math.min(RECONNECT_BACKOFF_BASE_MS * 2 ** (attempt - 1), RECONNECT_BACKOFF_MAX_MS);
        log.warn(
          `[sftp] 上传连接断开 (${err.message})，${delay}ms 后自动重连并断点续传 (${attempt}/${maxAttempts})...`
        );
        await sleep(delay);
        try {
          await this.reconnect();
        } catch (reconnectErr) {
          // 重连失败不终止流程：下一轮递归的 ensureConnected() 会再次尝试
          log.warn(`[sftp] 自动重连失败: ${reconnectErr.message}`);
        }
        return this.uploadResume(localPath, remotePath, onProgress, attempt + 1);
      }
      throw err instanceof ConnectionError ? err : new ConnectionError(`上传文件失败 ${localPath}: ${err.message}`, err);
    }
  }

  /**
   * 以追加模式打开远程文件（必要时先补建父目录）
   * @private
   * @param {object} sftp 底层 SFTP 对象
   * @param {string} remotePath 远程文件路径
   * @returns {Promise<Buffer>} 远程文件句柄
   */
  async _openRemoteAppend(sftp, remotePath) {
    const open = () =>
      new Promise((resolve, reject) => {
        sftp.open(remotePath, 'a', (err, h) => (err ? reject(err) : resolve(h)));
      });

    try {
      return await open();
    } catch (openErr) {
      // 若出现 No such file，通常是远程父目录在并发时未完成创建，补建后重试一次
      if (/no such file|ENOENT/i.test(openErr.message)) {
        await this.ensureRemoteDir(path.posix.dirname(remotePath));
        return open();
      }
      throw openErr;
    }
  }

  /**
   * 保序并发地把本地文件从 startOffset 起写入远程句柄
   *
   * 顺序保证：写请求严格按文件块的先后顺序提交；ssh2 在连接断开时会用
   * `No response from server` 拒绝所有挂起请求，因此不会出现永久挂起。
   *
   * @private
   * @param {object} sftp 底层 SFTP 对象
   * @param {Buffer} handle 远程文件句柄（追加模式）
   * @param {string} localPath 本地文件路径
   * @param {number} startOffset 本地文件读取起点（断点位置）
   * @param {Function} [onWritten] (bytesWrittenThisRun) => void 本轮已写入字节数回调
   * @returns {Promise<number>} 本轮实际写入的字节数
   */
  async _writeLocalToRemote(sftp, handle, localPath, startOffset, onWritten) {
    const concurrency = Math.max(1, parseInt(this.server?.pipeConcurrency, 10) || DEFAULT_PIPE_CONCURRENCY);
    const rs = fs.createReadStream(localPath, { start: startOffset, highWaterMark: WRITE_CHUNK_SIZE });
    const inFlight = new Set();
    let written = 0;
    let firstError = null;

    const submit = (chunk) => {
      const p = new Promise((resolve, reject) => {
        // APPEND 模式（SSH_FXF_APPEND）下协议强制写入文件末尾，忽略 position，传 0 即可
        sftp.write(handle, chunk, 0, chunk.length, 0, (err) => (err ? reject(err) : resolve()));
      })
        .then(() => {
          written += chunk.length;
          if (onWritten) onWritten(written);
        })
        .catch((err) => {
          if (!firstError) firstError = err;
        })
        .finally(() => {
          inFlight.delete(p);
        });
      inFlight.add(p);
    };

    try {
      for await (const chunk of rs) {
        // 控制并发：挂起请求达到上限时，等最早提交的一个落定
        while (inFlight.size >= concurrency) {
          await Promise.race(inFlight);
        }
        if (firstError) break;
        submit(chunk);
      }
      await Promise.all(inFlight);
    } finally {
      rs.destroy();
    }

    if (firstError) throw firstError;
    return written;
  }

  /**
   * 设置本地文件修改时间为远程 mtime（Pull 模式用）
   * @param {string} localPath
   * @param {number|Date} [mtime]
   */
  setMtime(localPath, mtime) {
    if (!mtime) return;
    const ts = new Date(mtime).getTime();
    if (!Number.isNaN(ts)) {
      fs.utimesSync(localPath, new Date(), new Date(ts));
    }
  }

  /**
   * 通过 SFTP 设置远程文件修改时间（Push 模式用）
   * @param {string} remotePath 远程文件路径
   * @param {number|Date} [mtime] 修改时间
   */
  async setRemoteMtime(remotePath, mtime) {
    if (!mtime) return;
    const mtimeDate = mtime instanceof Date ? mtime : new Date(mtime);
    const ts = mtimeDate.getTime();
    if (Number.isNaN(ts)) return;
    try {
      const sftp = this.client.sftp;
      // 使用底层 SFTP 原语设置远程文件 mtime
      const handle = await new Promise((resolve, reject) => {
        sftp.open(remotePath, 'r', (err, h) => (err ? reject(err) : resolve(h)));
      });
      const attrs = { mtime: Math.floor(ts / 1000) };
      await new Promise((resolve, reject) => {
        sftp.fsetstat(handle, attrs, (err) => (err ? reject(err) : resolve()));
      });
      await new Promise((resolve) => sftp.close(handle, () => resolve()));
    } catch (err) {
      // 设置远程 mtime 失败不阻塞主流程
    }
  }

  /**
   * 确保远程目录存在（递归创建，带并发互斥与路径缓存）
   * @param {string} remotePath 远程目录路径
   * @returns {Promise<void>}
   */
  async ensureRemoteDir(remotePath) {
    if (!remotePath || remotePath === '/' || remotePath === '.') return;
    const normalized = remotePath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalized) return;

    if (!this._ensuredRemoteDirs) {
      this._ensuredRemoteDirs = new Set();
    }
    if (this._ensuredRemoteDirs.has(normalized)) {
      return;
    }

    if (!this._mkdirLock) {
      this._mkdirLock = Promise.resolve();
    }

    await (this._mkdirLock = this._mkdirLock.then(async () => {
      if (this._ensuredRemoteDirs.has(normalized)) return;
      try {
        await this.client.mkdir(normalized, true);
        this._ensuredRemoteDirs.add(normalized);
      } catch (err) {
        // 尝试检查目录是否已由并发 worker 创建
        try {
          const stat = await this.client.stat(normalized);
          if (stat.isDirectory) {
            this._ensuredRemoteDirs.add(normalized);
            return;
          }
        } catch (_) {}
      }
    }));
  }

  /**
   * 获取远程真实路径（不传参数时返回登录主目录）
   * @param {string} [remotePath]
   * @returns {Promise<string>}
   */
  async realPath(remotePath) {
    try {
      return await this.client.realPath(remotePath || '.');
    } catch (err) {
      throw new ConnectionError(`获取远程路径失败: ${err.message}`, err);
    }
  }

  /**
   * 获取远程路径状态
   * @param {string} remotePath 远程路径
   * @returns {Promise<object>}
   */
  async stat(remotePath) {
    try {
      return await this.client.stat(remotePath);
    } catch (err) {
      throw new ConnectionError(`获取远程状态失败 ${remotePath}: ${err.message}`, err);
    }
  }

  /**
   * 关闭连接
   * @returns {Promise<void>}
   */
  async close() {
    await this._destroyClient();
  }

  /**
   * 删除远程文件
   * @param {string} remotePath
   * @returns {Promise<void>}
   */
  async deleteFile(remotePath) {
    try {
      await this.client.delete(remotePath);
    } catch (err) {
      throw new ConnectionError(`删除远程文件失败 ${remotePath}: ${err.message}`, err);
    }
  }

  /**
   * 删除远程目录（递归）
   * @param {string} remotePath
   * @returns {Promise<void>}
   */
  async deleteDir(remotePath) {
    try {
      await this.client.rmdir(remotePath, true);
    } catch (err) {
      throw new ConnectionError(`删除远程目录失败 ${remotePath}: ${err.message}`, err);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { SftpConnector };
