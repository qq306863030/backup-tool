'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SftpConnector } = require('../src/connectors/sftp');

/**
 * 构造一个用 mock 替换底层 client 的 SftpConnector 实例
 */
function makeMockConnector(tree) {
  // tree: { '/dir': [{ name, type, size?, modifyTime?, children? }] }
  const statResult = (path) => {
    if (tree[path] !== undefined) {
      return { isDirectory: true, size: 0, modifyTime: 0 };
    }
    // 视为文件
    return { isDirectory: false, size: 100, modifyTime: 1000 };
  };

  const client = {
    connect: async () => {},
    end: async () => {},
    stat: async (p) => statResult(p),
    list: async (dir) => {
      const items = tree[dir] || [];
      return items.map((it) => ({
        name: it.name,
        type: it.type, // 'd' | '-'
        size: it.size || 0,
        modifyTime: it.modifyTime || 0,
      }));
    },
  };

  const connector = new SftpConnector({ host: 'x', port: 22, username: 'u', connectTimeout: 1000, retry: { max: 1, delay: 0 } });
  connector.client = client;
  connector.connected = true;
  return connector;
}

test('SftpConnector.listFiles: 单文件直接返回', async () => {
  const conn = makeMockConnector({});
  const result = await conn.listFiles('/remote/single.txt');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].path, '/remote/single.txt');
  assert.strictEqual(result[0].isDirectory, false);
});

test('SftpConnector.listDirectory: 单层目录遍历', async () => {
  const conn = makeMockConnector({
    '/dir': [
      { name: 'a.txt', type: '-' },
      { name: 'b.txt', type: '-' },
    ],
  });
  const result = await conn.listDirectory('/dir');
  assert.strictEqual(result.length, 2);
  const names = result.map((r) => r.name).sort();
  assert.deepStrictEqual(names, ['a.txt', 'b.txt']);
});

test('SftpConnector.listDirectory: 多层嵌套目录全部展开', async () => {
  // 树形结构:
  // /root
  //   ├─ sub1/
  //   │   ├─ f1.txt
  //   │   └─ nested/
  //   │       └─ deep.txt
  //   └─ sub2/
  //       └─ f2.txt
  const conn = makeMockConnector({
    '/root': [
      { name: 'sub1', type: 'd' },
      { name: 'sub2', type: 'd' },
    ],
    '/root/sub1': [
      { name: 'f1.txt', type: '-' },
      { name: 'nested', type: 'd' },
    ],
    '/root/sub1/nested': [
      { name: 'deep.txt', type: '-' },
    ],
    '/root/sub2': [
      { name: 'f2.txt', type: '-' },
    ],
  });

  const result = await conn.listDirectory('/root');
  // 应包含: sub1, sub2, f1.txt, nested, deep.txt, f2.txt = 6 项
  assert.strictEqual(result.length, 6);
  const names = result.map((r) => r.name).sort();
  assert.deepStrictEqual(names, ['deep.txt', 'f1.txt', 'f2.txt', 'nested', 'sub1', 'sub2']);

  // 验证路径正确
  const deep = result.find((r) => r.name === 'deep.txt');
  assert.strictEqual(deep.path, '/root/sub1/nested/deep.txt');
  assert.strictEqual(deep.isDirectory, false);
  const sub1 = result.find((r) => r.name === 'sub1');
  assert.strictEqual(sub1.isDirectory, true);
});

test('SftpConnector.listDirectory: 单个目录 list 失败不影响整体', async () => {
  const conn = makeMockConnector({
    '/root': [
      { name: 'sub1', type: 'd' },
      { name: 'sub2', type: 'd' },
      { name: 'top.txt', type: '-' },
    ],
    '/root/sub1': [
      { name: 'f1.txt', type: '-' },
    ],
    // /root/sub2 故意不提供 → list 会返回 []
  });

  const result = await conn.listDirectory('/root');
  // 至少包含 top.txt 和 sub1、f1.txt
  const names = result.map((r) => r.name);
  assert.ok(names.includes('top.txt'));
  assert.ok(names.includes('sub1'));
  assert.ok(names.includes('f1.txt'));
});

test('SftpConnector.listDirectory: 并发下大量子目录不重不漏', async () => {
  // 构造一个根目录包含 50 个子目录，每个子目录有 5 个文件
  const tree = { '/root': [] };
  for (let i = 0; i < 50; i++) {
    const subName = `sub${i}`;
    tree['/root'].push({ name: subName, type: 'd' });
    tree[`/root/${subName}`] = [];
    for (let j = 0; j < 5; j++) {
      tree[`/root/${subName}`].push({ name: `f${j}.txt`, type: '-' });
    }
  }

  const conn = makeMockConnector(tree);
  const result = await conn.listDirectory('/root');
  // 50 (sub) + 50*5 (files) = 300 项
  assert.strictEqual(result.length, 300);

  // 验证每个子目录的文件都被列出
  const filesInSub0 = result.filter((r) => r.path.startsWith('/root/sub0/') && !r.isDirectory);
  assert.strictEqual(filesInSub0.length, 5);

  // 验证没有重复路径
  const paths = new Set(result.map((r) => r.path));
  assert.strictEqual(paths.size, 300);
});

test('SftpConnector.listFiles: 优先走 SSH find 极速流式扫描', async () => {
  const { Readable } = require('stream');
  const stdoutStream = new Readable({
    read() {
      this.push('/remote/dir/a.txt\t1024\t1700000000.123\tf\n');
      this.push('/remote/dir/sub\t4096\t1700000001.000\td\n');
      this.push(null);
    },
  });
  stdoutStream.stderr = new Readable({
    read() {
      this.push(null);
    },
  });

  let execCalled = false;
  const client = {
    client: {
      exec: (cmd, cb) => {
        execCalled = true;
        assert.ok(cmd.startsWith("find '/remote/dir'"));
        setTimeout(() => cb(null, stdoutStream), 5);
      },
    },
    stat: async () => ({ isDirectory: true }),
  };

  const connector = new SftpConnector({
    host: 'x',
    port: 22,
    username: 'u',
    connectTimeout: 1000,
    retry: { max: 1, delay: 0 },
  });
  connector.client = client;
  connector.connected = true;

  const result = await connector.listFiles('/remote/dir');
  assert.strictEqual(execCalled, true);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].name, 'a.txt');
  assert.strictEqual(result[0].size, 1024);
  assert.strictEqual(result[0].mtime, 1700000000123);
  assert.strictEqual(result[0].isDirectory, false);
  assert.strictEqual(result[1].name, 'sub');
  assert.strictEqual(result[1].isDirectory, true);
});

test('SftpConnector.isConnectionError: 正确识别 Keepalive timeout 及常规断网异常', () => {
  const connector = new SftpConnector({ host: 'x', port: 22, username: 'u', connectTimeout: 1000, retry: { max: 1, delay: 0 } });

  assert.strictEqual(connector.isConnectionError(new Error('Keepalive timeout')), true);
  assert.strictEqual(connector.isConnectionError(new Error('ECONNRESET')), true);
  assert.strictEqual(connector.isConnectionError(new Error('ETIMEDOUT')), true);
  assert.strictEqual(connector.isConnectionError(new Error('Channel closed')), true);
  assert.strictEqual(connector.isConnectionError(new Error('Socket closed')), true);
  assert.strictEqual(connector.isConnectionError(new Error('No such file or directory')), false);
  assert.strictEqual(connector.isConnectionError(new Error('Permission denied')), false);
});

test('SftpConnector.isConnectionError: 识别 ssh2 断线时抛出的 "No response from server"', () => {
  const connector = new SftpConnector({ host: 'x', port: 22, username: 'u', connectTimeout: 1000, retry: { max: 1, delay: 0 } });

  // ssh2 在 socket 关闭时以此错误拒绝所有挂起请求，必须纳入重连续传判定
  assert.strictEqual(connector.isConnectionError(new Error('No response from server')), true);
  assert.strictEqual(connector.isConnectionError(new Error('write ECONNRESET')), true);
  assert.strictEqual(connector.isConnectionError(new Error('socket hang up')), true);

  const socketErr = new Error('read ECONNRESET');
  socketErr.level = 'client-socket';
  assert.strictEqual(connector.isConnectionError(socketErr), true);

  // 包装层（ConnectionError 带 cause）同样应被识别
  const wrapped = new Error('上传文件失败 /tmp/a: No response from server');
  wrapped.cause = new Error('No response from server');
  assert.strictEqual(connector.isConnectionError(wrapped), true);
});

test('SftpConnector._writeLocalToRemote: 保序并发写入，数据顺序与文件一致', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-write-'));
  const local = path.join(tmpDir, 'data.bin');
  const payload = Buffer.alloc(300 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  fs.writeFileSync(local, payload);

  const writes = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const sftp = {
    write: (handle, chunk, off, len, pos, cb) => {
      writes.push(Buffer.from(chunk));
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // 模拟网络往返延迟：让本地读流有机会把并发流水线填满
      setTimeout(() => {
        inFlight--;
        cb(null);
      }, 5);
    },
  };

  const connector = new SftpConnector({
    host: 'x',
    port: 22,
    username: 'u',
    connectTimeout: 1000,
    retry: { max: 1, delay: 0 },
    pipeConcurrency: 4,
  });

  const offset = 100 * 1024;
  const written = await connector._writeLocalToRemote(sftp, Buffer.from('handle'), local, offset);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.strictEqual(written, payload.length - offset);
  // 并发写但提交顺序严格等于文件顺序 → 拼接结果必须与原文件剩余部分完全一致
  assert.deepStrictEqual(Buffer.concat(writes), payload.subarray(offset));
  // 确实发生了并发（未退化为逐块串行）
  assert.ok(maxInFlight > 1, `期望出现并发写，实际最大并发 ${maxInFlight}`);
});

test('SftpConnector.uploadResume: 遇 "No response from server" 自动重连并从断点续传成功', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-resume-'));
  const local = path.join(tmpDir, 'big.bin');
  const payload = Buffer.alloc(200 * 1024, 3);
  fs.writeFileSync(local, payload);

  // 模拟远端：已有 50KB 残片（上次断线遗留）
  let remoteData = Buffer.alloc(50 * 1024, 3);
  let writeCalls = 0;
  let connectCount = 0;

  const makeClient = () => ({
    sftp: {
      open: (p, flags, cb) => setImmediate(() => cb(null, Buffer.from('handle'))),
      close: (h, cb) => setImmediate(() => cb(null)),
      write: (h, chunk, off, len, pos, cb) => {
        writeCalls++;
        if (writeCalls === 2) {
          // 第二次写时模拟 TCP 被重置，ssh2 会以该错误拒绝所有挂起请求
          return setImmediate(() => cb(new Error('No response from server')));
        }
        remoteData = Buffer.concat([remoteData, Buffer.from(chunk)]);
        setImmediate(() => cb(null));
      },
    },
    stat: async () => ({ size: remoteData.length }),
    connect: async () => {
      connectCount++;
    },
    end: async () => {},
  });

  const connector = new SftpConnector({
    host: 'x',
    port: 22,
    username: 'u',
    auth: { type: 'password', password: 'pwd' },
    connectTimeout: 1000,
    retry: { max: 1, delay: 0 },
    pipeConcurrency: 1,
  });
  connector.client = makeClient();
  connector.connected = true;
  // 重连时会创建新的 client，这里复用同一份 mock
  connector._createSftpClient = () => makeClient();

  try {
    const result = await connector.uploadResume(local, '/remote/big.bin');

    assert.strictEqual(result.status, 'resumed');
    assert.strictEqual(connectCount, 1, '应触发一次自动重连');
    assert.strictEqual(remoteData.length, payload.length, '重连后应从断点续传至完整');
    assert.ok(remoteData.every((b) => b === 3), '续传后内容必须与原文件一致（无重复/错位写入）');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 回归测试：复现 v1.0.14 静默退出 0 的 bug
//
// 根因：连接被 RST 后 ssh2 的 SFTP 通道 outgoing.state 已是 closed，
// sftp.close(handle, cb) 把请求塞进 _requests 就再也不会回调
// （cleanupRequests 已经跑完了）。旧代码在 uploadResume 的 finally 里
// await 这个永不会落定的 Promise → 外层 catch 的断线重连永远不执行 →
// 事件循环空转 → 进程以退出码 0 退出 → bak exec 误报「备份完成」。
//
// 本测试验证：即使 sftp.close 从不回调，uploadResume 仍能识别断线错误
// 并在重连后从断点续传至完整（整个测试在 ~2s 内结束，不会卡住）。
// ---------------------------------------------------------------------------
test('SftpConnector.uploadResume: sftp.close 永不回调时仍能断线重连续传（v1.0.14 回归）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-close-hang-'));
  const local = path.join(tmpDir, 'data.bin');
  const payload = Buffer.alloc(200 * 1024, 7);
  fs.writeFileSync(local, payload);

  // 服务端已有 30KB 残片
  let remoteData = Buffer.alloc(30 * 1024, 7);
  let writeCalls = 0;
  let connectCount = 0;

  // 第一轮：write 第二次报错（模拟断线），close 永不回调
  const makeFirstClient = () => ({
    sftp: {
      open: (p, flags, cb) => setImmediate(() => cb(null, Buffer.from('handle1'))),
      close: (_h, _cb) => { /* 永不回调：复现 ssh2 cleanupRequests 后孤儿请求 */ },
      write: (_h, chunk, _off, _len, _pos, cb) => {
        writeCalls++;
        if (writeCalls === 2) return setImmediate(() => cb(new Error('No response from server')));
        remoteData = Buffer.concat([remoteData, Buffer.from(chunk)]);
        setImmediate(() => cb(null));
      },
    },
    stat: async () => ({ size: remoteData.length }),
    connect: async () => { connectCount++; },
    end: async () => {},
  });

  // 第二轮（重连后）：全部正常
  const makeSecondClient = () => ({
    sftp: {
      open: (p, flags, cb) => setImmediate(() => cb(null, Buffer.from('handle2'))),
      close: (_h, cb) => setImmediate(() => cb(null)),
      write: (_h, chunk, _off, _len, _pos, cb) => {
        remoteData = Buffer.concat([remoteData, Buffer.from(chunk)]);
        setImmediate(() => cb(null));
      },
    },
    stat: async () => ({ size: remoteData.length }),
    connect: async () => { connectCount++; },
    end: async () => {},
  });

  const connector = new SftpConnector({
    host: 'x', port: 22, username: 'u',
    auth: { type: 'password', password: 'pwd' },
    connectTimeout: 1000,
    retry: { max: 1, delay: 0 },
    pipeConcurrency: 1,
  });

  let firstClient = makeFirstClient();
  connector.client = firstClient;
  connector.connected = true;
  // 重连后替换为新 client
  let reconnectClient = makeSecondClient();
  connector._createSftpClient = () => reconnectClient;

  try {
    const t0 = Date.now();
    const result = await connector.uploadResume(local, '/remote/data.bin');
    const elapsed = Date.now() - t0;

    assert.strictEqual(result.status, 'resumed');
    assert.strictEqual(connectCount, 1, '应触发一次自动重连');
    assert.ok(elapsed < 10000, `整个流程应在 10s 内结束（含句柄关闭超时），实际 ${elapsed}ms`);
    assert.strictEqual(remoteData.length, payload.length, '重连后应从断点续传至完整');
    assert.ok(remoteData.every((b) => b === 7), '续传内容必须与原文件一致');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 回归测试：_writeLocalToRemote 静默看门狗
//
// 验证：服务端完全不响应时，stall guard 在配置的超时后主动抛出
// 带有 level='client-timeout' 的错误（从而被 isConnectionError 识别为断线），
// 而不是永远挂住。使用极短的 stallTimeout（50ms）加速测试。
// ---------------------------------------------------------------------------
test('SftpConnector._writeLocalToRemote: 服务端无应答时静默看门狗在超时后抛错（不挂起）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-stall-'));
  const local = path.join(tmpDir, 'big.bin');
  fs.writeFileSync(local, Buffer.alloc(512 * 1024, 1));

  // 服务端 write 永不回调（模拟假死）
  const sftp = {
    write: (_h, _chunk, _off, _len, _pos, _cb) => { /* 永不调用 */ },
  };

  const connector = new SftpConnector({
    host: 'x', port: 22, username: 'u', connectTimeout: 1000, retry: { max: 1, delay: 0 },
    stallTimeout: 50,    // 50ms 看门狗，加速测试
    pipeConcurrency: 1,
  });
  connector.connected = true;

  const t0 = Date.now();
  let threw = false;
  try {
    await connector._writeLocalToRemote(sftp, Buffer.from('h'), local, 0);
  } catch (err) {
    threw = true;
    assert.strictEqual(err.level, 'client-timeout', '错误 level 必须是 client-timeout，否则断线重连不会触发');
    assert.ok(/静默超时/.test(err.message), '错误信息应包含「静默超时」关键字');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  assert.strictEqual(threw, true, '看门狗必须在超时后主动抛错');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `整个流程应在 5s 内结束，实际 ${elapsed}ms`);
});
