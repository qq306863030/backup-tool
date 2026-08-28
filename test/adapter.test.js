'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { adaptConfig, detectAuth, expandHome } = require('../src/config/adapter');

test('expandHome: 展开 ~ 为 home 目录', () => {
  assert.strictEqual(expandHome('~/foo'), path.join(os.homedir(), 'foo'));
  assert.strictEqual(expandHome('~/.backup-tool/backups'), path.join(os.homedir(), '.backup-tool', 'backups'));
  assert.strictEqual(expandHome('~'), os.homedir());
});

test('expandHome: 非 ~ 路径原样返回', () => {
  assert.strictEqual(expandHome('/abs/path'), '/abs/path');
  assert.strictEqual(expandHome('./rel/path'), './rel/path');
  assert.strictEqual(expandHome(''), '');
});

test('adaptConfig: destination 中的 ~ 被展开', () => {
  const raw = {
    servers: [
      {
        host: '1.2.3.4',
        username: 'root',
        password: 'secret',
        tasks: [
          { name: 't1', type: 'incremental', cron: '0 2 * * *', source: '/a', destination: '~/backups/t1' },
        ],
      },
    ],
  };
  const config = adaptConfig(raw);
  assert.strictEqual(config.servers[0].tasks[0].destination, path.join(os.homedir(), 'backups', 't1'));
});

test('adaptConfig: log.dir 中的 ~ 被展开', () => {
  const raw = {
    log: { dir: '~/mylogs' },
    servers: [
      {
        host: '1.2.3.4',
        username: 'root',
        password: 'secret',
        tasks: [
          { name: 't1', type: 'incremental', cron: '0 2 * * *', source: '/a', destination: './b' },
        ],
      },
    ],
  };
  const config = adaptConfig(raw);
  assert.strictEqual(config.log.dir, path.join(os.homedir(), 'mylogs'));
});

test('adaptConfig: 填充默认值', () => {
  const raw = {
    servers: [
      {
        host: '1.2.3.4',
        username: 'root',
        password: 'secret',
        tasks: [
          { name: 't1', type: 'incremental', cron: '0 2 * * *', source: '/a', destination: './b' },
        ],
      },
    ],
  };
  const config = adaptConfig(raw);
  const server = config.servers[0];
  assert.strictEqual(server.port, 22);
  assert.strictEqual(server.connectTimeout, 10000);
  assert.deepStrictEqual(server.retry, { max: 3, delay: 5000 });
  assert.strictEqual(server.auth.type, 'password');

  const task = server.tasks[0];
  assert.strictEqual(task.direction, 'pull');
  assert.strictEqual(task.enabled, true);
  assert.deepStrictEqual(task.incremental.compareBy, ['name', 'size', 'mtime']);
  assert.strictEqual(task.incremental.deleteRemoved, false);
  assert.strictEqual(task.incremental.concurrency, 4);
});

test('adaptConfig: direction 为 push 时 source 展开 ~，destination 保持 POSIX 路径', () => {
  const raw = {
    servers: [
      {
        host: '1.2.3.4',
        username: 'root',
        password: 'secret',
        tasks: [
          {
            name: 'push-task',
            direction: 'push',
            type: 'incremental',
            cron: '0 2 * * *',
            source: '~/dist',
            destination: '/var/www/html',
          },
        ],
      },
    ],
  };
  const config = adaptConfig(raw);
  const task = config.servers[0].tasks[0];
  assert.strictEqual(task.direction, 'push');
  assert.strictEqual(task.source, path.join(os.homedir(), 'dist'));
  assert.strictEqual(task.destination, '/var/www/html');
});

test('adaptConfig: direction 为空字符串时默认为 pull', () => {
  const raw = {
    servers: [
      {
        host: '1.2.3.4',
        username: 'root',
        password: 'secret',
        tasks: [
          {
            name: 'default-direction-task',
            direction: '',
            type: 'incremental',
            cron: '0 2 * * *',
            source: '/a',
          },
        ],
      },
    ],
  };
  const config = adaptConfig(raw);
  const task = config.servers[0].tasks[0];
  assert.strictEqual(task.direction, 'pull');
  assert.strictEqual(task.source, '/a');
  assert.strictEqual(task.destination, path.join(os.homedir(), '.backup-tool', 'backups', 'default-direction-task'));
});

test('adaptConfig: 认证自动判断 - 密码', () => {
  const auth = detectAuth({ host: 'h', username: 'u', password: 'p' });
  assert.deepStrictEqual(auth, { type: 'password', password: 'p' });
});

test('adaptConfig: 认证自动判断 - 私钥', () => {
  const auth = detectAuth({ host: 'h', username: 'u', privateKeyPath: '/key', passphrase: 'pp' });
  assert.deepStrictEqual(auth, { type: 'privateKey', privateKeyPath: '/key', passphrase: 'pp' });
});

test('adaptConfig: 认证自动判断 - 无认证报错', () => {
  assert.throws(() => detectAuth({ host: 'h', username: 'u' }));
});

test('adaptConfig: 全量任务默认值', () => {
  const raw = {
    servers: [
      {
        host: '1.2.3.4',
        username: 'root',
        privateKeyPath: '/key',
        tasks: [
          { name: 't1', type: 'full', cron: '0 3 * * 0', source: '/a', destination: './b' },
        ],
      },
    ],
  };
  const config = adaptConfig(raw);
  const task = config.servers[0].tasks[0];
  assert.strictEqual(task.full.maxBackups, 5);
  assert.strictEqual(task.full.compress, true);
  assert.strictEqual(task.full.timestampFormat, 'YYYYMMDD-HHmmss');
});

test('adaptConfig: 缺少 servers 报错', () => {
  assert.throws(() => adaptConfig({}));
});

test('adaptConfig: 缺少认证报错', () => {
  const raw = {
    servers: [
      { host: '1.2.3.4', username: 'root', tasks: [] },
    ],
  };
  assert.throws(() => adaptConfig(raw));
});
