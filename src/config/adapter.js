'use strict';

const path = require('path');
const os = require('os');
const { ConfigError } = require('../errors');
const { DEFAULT_LOG_DIR, DEFAULT_BACKUP_DIR } = require('../paths');

/**
 * 配置适配器：将用户极简配置转换为内部标准配置
 * - 填充默认值
 * - 根据 password/privateKeyPath 自动判断认证类型
 * - 归一化 include/exclude 为数组
 */

const DEFAULTS = {
  log: { level: 'info', dir: DEFAULT_LOG_DIR, maxFiles: 30, maxSize: '10m' },
  server: {
    port: 22,
    connectTimeout: 10000,
    retry: { max: 3, delay: 5000 },
  },
  task: {
    enabled: true,
    destination: DEFAULT_BACKUP_DIR,
  },
  incremental: {
    compareBy: ['name', 'size', 'mtime'],
    deleteRemoved: false,
    include: [],
    exclude: [],
    concurrency: 4,
  },
  full: {
    maxBackups: 5,
    timestampFormat: 'YYYYMMDD-HHmmss',
    compress: true,
    exclude: [],
  },
};

/**
 * 展开路径中的 ~ 为 home 目录
 * 支持：
 *   ~/xxx        -> <home>/xxx
 *   ~/.backup-tool/xxx -> <home>/.backup-tool/xxx
 * @param {string} p 路径
 * @returns {string} 展开后的路径
 */
function expandHome(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * 适配顶层配置
 * @param {object} raw 用户配置
 * @returns {object} 内部标准配置
 */
function adaptConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError('配置必须是对象');
  }

  const log = { ...DEFAULTS.log, ...(raw.log || {}) };
  // 展开日志目录中的 ~
  log.dir = expandHome(log.dir);

  if (!Array.isArray(raw.servers) || raw.servers.length === 0) {
    throw new ConfigError('配置缺少 servers 数组');
  }

  const servers = raw.servers.map(adaptServer);

  return { log, servers };
}

/**
 * 适配单个服务器
 * @param {object} server 用户服务器配置
 * @returns {object} 内部标准服务器配置
 */
function adaptServer(server) {
  if (!server || typeof server !== 'object') {
    throw new ConfigError('服务器配置必须是对象');
  }
  if (!server.host) throw new ConfigError('服务器缺少 host');
  if (!server.username) throw new ConfigError(`服务器 ${server.host} 缺少 username`);

  // 认证自动判断
  const auth = detectAuth(server);

  const adapted = {
    host: server.host,
    port: server.port ?? DEFAULTS.server.port,
    username: server.username,
    auth,
    connectTimeout: server.connectTimeout ?? DEFAULTS.server.connectTimeout,
    retry: {
      max: server.retry?.max ?? DEFAULTS.server.retry.max,
      delay: server.retry?.delay ?? DEFAULTS.server.retry.delay,
    },
  };

  if (!Array.isArray(server.tasks) || server.tasks.length === 0) {
    throw new ConfigError(`服务器 ${server.host} 缺少 tasks 数组`);
  }

  adapted.tasks = server.tasks.map((task) => adaptTask(task, server.host));

  return adapted;
}

/**
 * 自动判断认证类型
 * @param {object} server
 * @returns {object} { type, password? | privateKeyPath?, passphrase? }
 */
function detectAuth(server) {
  const hasPassword = typeof server.password === 'string' && server.password.length > 0;
  const hasPrivateKey = typeof server.privateKeyPath === 'string' && server.privateKeyPath.length > 0;

  if (hasPassword && hasPrivateKey) {
    // 两者都有，优先密码（或可改为报错，这里选择密码优先）
    return { type: 'password', password: server.password };
  }
  if (hasPassword) {
    return { type: 'password', password: server.password };
  }
  if (hasPrivateKey) {
    const auth = { type: 'privateKey', privateKeyPath: server.privateKeyPath };
    if (server.passphrase) auth.passphrase = server.passphrase;
    return auth;
  }
  throw new ConfigError(`服务器 ${server.host} 缺少认证信息（password 或 privateKeyPath）`);
}

/**
 * 适配单个任务
 * @param {object} task 用户任务配置
 * @param {string} host 所属服务器 host（用于错误提示）
 * @returns {object} 内部标准任务配置
 */
function adaptTask(task, host) {
  if (!task || typeof task !== 'object') {
    throw new ConfigError(`服务器 ${host} 的任务配置必须是对象`);
  }
  if (!task.name) throw new ConfigError(`服务器 ${host} 的任务缺少 name`);
  if (!task.type || !['incremental', 'full'].includes(task.type)) {
    throw new ConfigError(`任务 ${task.name} 的 type 必须是 incremental 或 full`);
  }
  if (!task.cron) throw new ConfigError(`任务 ${task.name} 缺少 cron`);
  if (!task.source) throw new ConfigError(`任务 ${task.name} 缺少 source`);

  const adapted = {
    name: task.name,
    enabled: task.enabled ?? DEFAULTS.task.enabled,
    type: task.type,
    cron: task.cron,
    source: task.source,
    // destination 可选，默认 ~/.backup-tool/backups/<name>，并展开 ~
    destination: expandHome(task.destination || path.join(DEFAULTS.task.destination, task.name)),
  };

  if (task.type === 'incremental') {
    adapted.incremental = {
      compareBy: task.incremental?.compareBy ?? DEFAULTS.incremental.compareBy,
      deleteRemoved: task.incremental?.deleteRemoved ?? DEFAULTS.incremental.deleteRemoved,
      include: normalizeArray(task.incremental?.include),
      exclude: normalizeArray(task.incremental?.exclude),
      concurrency: task.incremental?.concurrency ?? DEFAULTS.incremental.concurrency,
    };
  } else {
    adapted.full = {
      maxBackups: task.full?.maxBackups ?? DEFAULTS.full.maxBackups,
      timestampFormat: task.full?.timestampFormat ?? DEFAULTS.full.timestampFormat,
      compress: task.full?.compress ?? DEFAULTS.full.compress,
      exclude: normalizeArray(task.full?.exclude),
    };
  }

  return adapted;
}

/**
 * 归一化为数组
 * @param {*} value
 * @returns {string[]}
 */
function normalizeArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

module.exports = { adaptConfig, adaptServer, adaptTask, detectAuth, expandHome, DEFAULTS };
