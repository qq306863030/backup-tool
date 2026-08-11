'use strict';

const fs = require('fs');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');
const { ConnectionError } = require('../errors');

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

    let lastErr = null;
    for (let attempt = 1; attempt <= retry.max; attempt++) {
      try {
        await this.client.connect(config);
        this.connected = true;
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < retry.max) {
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
    try {
      // 先判断是文件还是目录
      const stat = await this.client.stat(remotePath);
      if (!stat.isDirectory) {
        // 单个文件
        return [{
          name: path.basename(remotePath),
          path: remotePath,
          size: stat.size,
          mtime: stat.modifyTime,
          isDirectory: false,
        }];
      }
      return await this.listDirectory(remotePath);
    } catch (err) {
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
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { SftpConnector };
