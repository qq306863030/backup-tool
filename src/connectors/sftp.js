'use strict';

const fs = require('fs');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');
const { ConnectionError } = require('../errors');
const { getLogger } = require('../utils/logger');

/** 格式化字节数为人类可读 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

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
    this.client = new SftpClient();
    this.connected = false;
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
   * 列出路径下的文件（支持文件或目录，目录递归）
   * @param {string} remotePath 远程路径（文件或目录）
   * @returns {Promise<Array<{name, path, size, mtime, isDirectory}>>}
   */
  async listFiles(remotePath) {
    const log = getLogger();
    log.info(`[sftp] 正在列出远程路径 ${remotePath}...`);
    const t0 = Date.now();
    try {
      // 先判断是文件还是目录
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
      const result = await this.listDirectory(remotePath);
      log.info(`[sftp] 列出完成 ${remotePath}（共 ${result.length} 项，耗时 ${Date.now() - t0}ms）`);
      return result;
    } catch (err) {
      log.warn(`[sftp] 列出远程路径失败 ${remotePath}: ${err.message}`);
      throw new ConnectionError(`列出远程路径失败 ${remotePath}: ${err.message}`, err);
    }
  }

  /**
   * 递归列出目录下的所有文件
   * @param {string} remotePath 远程目录
   * @returns {Promise<Array<{name, path, size, mtime, isDirectory}>>}
   */
  async listDirectory(remotePath) {
    const items = await this.client.list(remotePath);
    const result = [];
    for (const item of items) {
      const fullPath = `${remotePath.replace(/\/+$/, '')}/${item.name}`;
      const entry = {
        name: item.name,
        path: fullPath,
        size: item.size,
        mtime: item.modifyTime,
        isDirectory: item.type === 'd',
      };
      result.push(entry);
      if (item.type === 'd') {
        const children = await this.listDirectory(fullPath);
        result.push(...children);
      }
    }
    return result;
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
   * @returns {Promise<{status: string, transferred: number, total: number}>}
   *          status: completed（完整下载）/ resumed（续传）/ skipped（已存在跳过）
   */
  async downloadResume(remotePath, localPath, mtime, onProgress) {
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

    this.setMtime(localPath, mtime);
    return { status: localSize > 0 ? 'resumed' : 'completed', transferred: total, total };
  }

  /**
   * 断点续传上传单个文件
   * 远程已有部分数据时从断点继续（以追加模式写入末尾）
   * @param {string} localPath 本地文件路径
   * @param {string} remotePath 远程文件路径
   * @param {Function} [onProgress] (transferred, total) => void 进度回调
   * @returns {Promise<{status: string, transferred: number, total: number}>}
   *          status: completed（完整上传）/ resumed（续传）/ skipped（已存在跳过）
   */
  async uploadResume(localPath, remotePath, onProgress) {
    const total = fs.statSync(localPath).size;
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
    // write 时 position 传 null，数据始终写入文件末尾，实现断点续传
    const sftp = this.client.sftp;
    const handle = await new Promise((resolve, reject) => {
      sftp.open(remotePath, 'a', (err, h) => (err ? reject(err) : resolve(h)));
    });

    let transferred = remoteSize;
    let lastProgressAt = 0;
    try {
      const rs = fs.createReadStream(localPath, { start: remoteSize, highWaterMark: 64 * 1024 });
      for await (const chunk of rs) {
        // APPEND 模式（SSH_FXF_APPEND）下协议强制写入文件末尾，忽略 position，传 0 即可
        await new Promise((resolve, reject) => {
          sftp.write(handle, chunk, 0, chunk.length, 0, (err) =>
            err ? reject(err) : resolve()
          );
        });
        transferred += chunk.length;
        if (onProgress) onProgress(transferred, total);

        // 大文件每 5 秒打印一次进度日志，便于观察是否真的在传
        const now = Date.now();
        if (now - lastProgressAt >= 5000) {
          lastProgressAt = now;
          const pct = ((transferred / total) * 100).toFixed(1);
          const speed = transferred / ((now - t0) / 1000);
          log.info(`[sftp] ${baseName} 上传进度: ${formatBytes(transferred)}/${formatBytes(total)} (${pct}%) ${formatBytes(speed)}/s`);
        }
      }
    } catch (err) {
      throw new ConnectionError(`上传文件失败 ${localPath}: ${err.message}`, err);
    } finally {
      await new Promise((resolve) => sftp.close(handle, () => resolve()));
    }
    const duration = Date.now() - t0;
    log.info(`[sftp] 上传完成 ${baseName}: ${formatBytes(transferred)}/${formatBytes(total)}（耗时 ${duration}ms）`);
    return { status: remoteSize > 0 ? 'resumed' : 'completed', transferred: total, total };
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
   * 确保远程目录存在（递归创建，已存在时忽略）
   * @param {string} remotePath 远程目录路径
   * @returns {Promise<void>}
   */
  async ensureRemoteDir(remotePath) {
    try {
      await this.client.mkdir(remotePath, true);
    } catch (err) {
      // 目录已存在时部分实现会报错，忽略即可
    }
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
    if (this.connected) {
      try {
        await this.client.end();
      } catch (err) {
        // 忽略关闭错误
      }
      this.connected = false;
    }
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
