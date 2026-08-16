'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config/loader');
const { adaptConfig } = require('./config/adapter');
const { validateConfig } = require('./config/schema');
const { initLogger } = require('./utils/logger');
const { SftpConnector } = require('./connectors/sftp');

/**
 * 格式化字节大小
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

/**
 * 单行覆盖式进度显示（\r 回到行首，不换行）
 */
function createProgress() {
  let lastLen = 0;
  let lastTick = 0;
  return {
    /**
     * 刷新进度
     * @param {string} label 进度描述
     * @param {number} transferred 已传输字节
     * @param {number} total 总字节
     */
    update(label, transferred, total) {
      const now = Date.now();
      // 节流：首次立即显示，之后至少 100ms 刷新一次，避免刷新过快
      if (lastTick !== 0 && now - lastTick < 100) return;
      lastTick = now;
      const pct = total > 0 ? Math.min(100, (transferred / total) * 100) : 100;
      const line = `${label}: ${formatSize(transferred)} / ${formatSize(total)} (${pct.toFixed(1)}%)`;
      process.stdout.write('\r' + ' '.repeat(lastLen) + '\r' + line);
      lastLen = line.length;
    },
    /**
     * 清除进度行（完成后调用，避免残留）
     */
    clear() {
      if (lastLen > 0) {
        process.stdout.write('\r' + ' '.repeat(lastLen) + '\r');
        lastLen = 0;
      }
    },
  };
}

/**
 * 传输结果状态的中文描述
 * @param {string} status
 * @returns {string}
 */
function statusText(status) {
  if (status === 'skipped') return '已存在，跳过';
  if (status === 'resumed') return '续传完成';
  return '完成';
}

/**
 * 传输工具：上传/下载文件或目录（backup up / backup down）
 */
class TransferRunner {
  /**
   * @param {object} logger
   */
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * 上传本地文件/目录到远程目标目录
   * 远程路径 = remoteDir/<basename>，目录递归上传
   * @param {SftpConnector} connector
   * @param {string} localPath 本地文件或目录
   * @param {string} remoteDir 远程目标目录
   * @returns {Promise<void>}
   */
  async upload(connector, localPath, remoteDir) {
    const abs = path.resolve(localPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`本地路径不存在: ${abs}`);
    }
    const stat = fs.statSync(abs);
    const target = `${remoteDir.replace(/\/+$/, '')}/${path.basename(abs)}`;
    if (stat.isDirectory()) {
      await this.uploadDirectory(connector, abs, target);
    } else {
      await this.uploadFile(connector, abs, target);
    }
  }

  /**
   * 上传单个文件（断点续传 + 单行进度）
   * @param {SftpConnector} connector
   * @param {string} localPath 本地文件
   * @param {string} remotePath 远程文件
   * @returns {Promise<void>}
   */
  async uploadFile(connector, localPath, remotePath) {
    this.logger.info(`[transfer] 上传文件 ${localPath} -> ${remotePath}`);
    await connector.ensureRemoteDir(path.posix.dirname(remotePath));
    const progress = createProgress();
    const baseName = path.basename(localPath);
    let result;
    try {
      result = await connector.uploadResume(localPath, remotePath, (t, total) =>
        progress.update(`上传 ${baseName}`, t, total)
      );
    } finally {
      progress.clear();
    }
    this.logger.info(`[transfer] 上传${statusText(result.status)}: ${baseName} (${formatSize(result.total)})`);
  }

  /**
   * 递归上传目录
   * @param {SftpConnector} connector
   * @param {string} localDir 本地目录
   * @param {string} remoteDir 远程目录
   * @returns {Promise<void>}
   */
  async uploadDirectory(connector, localDir, remoteDir) {
    this.logger.info(`[transfer] 上传目录 ${localDir} -> ${remoteDir}`);
    await connector.ensureRemoteDir(remoteDir);
    const entries = fs.readdirSync(localDir, { withFileTypes: true });
    for (const entry of entries) {
      const localEntry = path.join(localDir, entry.name);
      const remoteEntry = `${remoteDir.replace(/\/+$/, '')}/${entry.name}`;
      if (entry.isDirectory()) {
        await this.uploadDirectory(connector, localEntry, remoteEntry);
      } else if (entry.isFile()) {
        await this.uploadFile(connector, localEntry, remoteEntry);
      }
    }
  }

  /**
   * 下载远程文件/目录到本地目标目录
   * 本地路径 = localDir/<basename>，目录递归下载
   * @param {SftpConnector} connector
   * @param {string} remotePath 远程文件或目录
   * @param {string} localDir 本地目标目录
   * @returns {Promise<void>}
   */
  async download(connector, remotePath, localDir) {
    const targetDir = path.resolve(localDir);
    const remoteBase = remotePath.replace(/\/+$/, '');
    const baseName = path.posix.basename(remoteBase);

    // 用 stat 判断远程是文件还是目录（避免目录内单文件被误判）
    const stat = await connector.stat(remotePath);
    const files = await connector.listFiles(remotePath);
    if (stat.isDirectory) {
      // 远程是目录（含空目录）
      await this.downloadDirectory(connector, files, remoteBase, path.join(targetDir, baseName));
    } else {
      // 远程是单个文件
      await this.downloadFile(connector, files[0], path.join(targetDir, baseName));
    }
  }

  /**
   * 下载单个文件（断点续传 + 单行进度）
   * @param {SftpConnector} connector
   * @param {object} file { path, mtime }
   * @param {string} localPath 本地文件
   * @returns {Promise<void>}
   */
  async downloadFile(connector, file, localPath) {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    this.logger.info(`[transfer] 下载文件 ${file.path} -> ${localPath}`);
    const progress = createProgress();
    const baseName = path.basename(localPath);
    let result;
    try {
      result = await connector.downloadResume(file.path, localPath, file.mtime, (t, total) =>
        progress.update(`下载 ${baseName}`, t, total)
      );
    } finally {
      progress.clear();
    }
    this.logger.info(`[transfer] 下载${statusText(result.status)}: ${baseName} (${formatSize(result.total)})`);
  }

  /**
   * 递归下载目录（保持远程目录结构）
   * @param {SftpConnector} connector
   * @param {object[]} files listFiles 递归结果
   * @param {string} remoteBase 远程根目录
   * @param {string} localDir 本地目标目录
   * @returns {Promise<void>}
   */
  async downloadDirectory(connector, files, remoteBase, localDir) {
    fs.mkdirSync(localDir, { recursive: true });
    let count = 0;
    for (const file of files) {
      // listFiles 结果中含目录条目，跳过（子文件已包含在递归列表中）
      if (file.isDirectory) continue;
      // 计算相对远程根目录的路径，保留目录结构
      const rel = file.path.slice(remoteBase.length).replace(/^\/+/, '');
      const localFile = path.join(localDir, rel.replace(/\//g, path.sep));
      await this.downloadFile(connector, file, localFile);
      count++;
    }
    this.logger.info(`[transfer] 目录下载完成: ${remoteBase} -> ${localDir} (${count} 个文件)`);
  }
}

/**
 * 解析远程路径：
 * - 绝对路径（以 / 开头）原样使用
 * - 相对路径或默认路径以 basedir 为基准拼接
 * @param {string|null} basedir 服务器 upload-basedir 基准目录
 * @param {string} p 用户提供的远程路径（可为空，空时返回 basedir 本身）
 * @returns {string} 解析后的远程路径
 */
function resolveRemote(basedir, p) {
  if (!p || p.length === 0) {
    return basedir || '';
  }
  // 绝对路径直接使用
  if (p.startsWith('/')) {
    return p;
  }
  // 有 basedir 时以 basedir 为基准
  if (basedir) {
    return `${basedir.replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}`;
  }
  // 无 basedir 时保持原样（相对服务器主目录）
  return p;
}

/**
 * 执行上传/下载（backup up / backup down 入口）
 * @param {string} configPath 配置文件路径
 * @param {'up'|'down'} action 操作类型
 * @param {string} serverName 服务器名称或 host
 * @param {string} source 源路径（上传为本地路径，下载为远程路径）
 * @param {string} [target] 目标路径（可选：上传默认服务器 basedir，下载默认本地当前目录）
 * @returns {Promise<void>}
 */
async function runTransfer(configPath, action, serverName, source, target) {
  const raw = loadConfig(configPath);
  const config = adaptConfig(raw);
  validateConfig(config);

  // 按 name 或 host 匹配服务器
  const server = config.servers.find((s) => s.name === serverName || s.host === serverName);
  if (!server) {
    const names = config.servers.map((s) => `${s.name} (${s.host})`).join(', ');
    throw new Error(`未找到服务器 "${serverName}"，可用服务器: ${names}`);
  }

  const logger = initLogger(config.log);
  const actionText = action === 'up' ? '上传' : '下载';
  logger.info(`[transfer] ${actionText}开始: ${serverName} ${source}${target ? ` -> ${target}` : ''}`);

  const connector = new SftpConnector(server);
  try {
    await connector.connect();
    const runner = new TransferRunner(logger);
    if (action === 'up') {
      // 上传：目标远程目录解析（默认 basedir，未配置 basedir 时默认服务器主目录）
      const remoteDir = resolveRemote(server.uploadBasedir, target) || (await connector.realPath());
      await runner.upload(connector, source, remoteDir);
    } else if (action === 'down') {
      // 下载：源远程路径解析（相对路径以 basedir 为基准）
      const remotePath = resolveRemote(server.uploadBasedir, source);
      // 下载：默认目标为本地当前目录
      const localDir = target || process.cwd();
      await runner.download(connector, remotePath, localDir);
    } else {
      throw new Error(`未知操作: ${action}`);
    }
    logger.info('[transfer] 操作完成');
  } finally {
    await connector.close();
  }
}

module.exports = { TransferRunner, runTransfer };
