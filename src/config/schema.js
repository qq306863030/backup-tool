'use strict';

const { ConfigError } = require('../errors');

/**
 * 配置校验：对适配后的内部标准配置做最终校验
 */

/**
 * 校验适配后的配置
 * @param {object} config 内部标准配置
 * @returns {object} 校验通过返回原配置
 */
function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new ConfigError('配置必须是对象');
  }

  if (!Array.isArray(config.servers) || config.servers.length === 0) {
    throw new ConfigError('配置缺少 servers');
  }

  for (const server of config.servers) {
    validateServer(server);
  }

  return config;
}

function validateServer(server) {
  if (!server.host) throw new ConfigError('服务器缺少 host');
  if (!server.username) throw new ConfigError(`服务器 ${server.host} 缺少 username`);
  if (!server.auth || !server.auth.type) {
    throw new ConfigError(`服务器 ${server.host} 缺少认证信息`);
  }
  if (server.auth.type === 'password' && !server.auth.password) {
    throw new ConfigError(`服务器 ${server.host} 密码认证缺少 password`);
  }
  if (server.auth.type === 'privateKey' && !server.auth.privateKeyPath) {
    throw new ConfigError(`服务器 ${server.host} 私钥认证缺少 privateKeyPath`);
  }
  if (!Array.isArray(server.tasks) || server.tasks.length === 0) {
    throw new ConfigError(`服务器 ${server.host} 缺少 tasks`);
  }
  for (const task of server.tasks) {
    validateTask(task, server.host);
  }
}

function validateTask(task, host) {
  if (!task.name) throw new ConfigError(`服务器 ${host} 的任务缺少 name`);
  if (!['incremental', 'full'].includes(task.type)) {
    throw new ConfigError(`任务 ${task.name} 的 type 非法`);
  }
  if (!task.cron) throw new ConfigError(`任务 ${task.name} 缺少 cron`);
  if (!task.source) throw new ConfigError(`任务 ${task.name} 缺少 source`);
  if (!task.destination) throw new ConfigError(`任务 ${task.name} 缺少 destination`);
}

module.exports = { validateConfig };
