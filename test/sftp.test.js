'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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