'use strict';

/**
 * Rollup 打包配置
 * 将 CLI 工具打包为单个可执行文件（CommonJS bundle）
 *
 * 用法：
 *   npm run build         打包当前平台
 *   npm run build:win     打包 Windows
 *   npm run build:linux   打包 Linux
 *   npm run build:mac     打包 macOS
 */

const { nodeResolve } = require('@rollup/plugin-node-resolve');
const commonjs = require('@rollup/plugin-commonjs');
const json = require('@rollup/plugin-json');

// 需要保持 external 的依赖（不打包进 bundle）
// 这些依赖包含原生模块或动态加载，打包会导致运行时错误
const EXTERNAL = [
  'ssh2',
  'ssh2-sftp-client',
  'archiver',
  'archiver-utils',
  'winston',
  'winston-transport',
  'node-cron',
  'json5',
  'dayjs',
  'micromatch',
  'fast-glob',
  'fs-extra',
  'graceful-fs',
  'readable-stream',
  'stream',
  'util',
  'path',
  'fs',
  'os',
  'child_process',
  'crypto',
  'events',
  'buffer',
  'stream',
  'zlib',
  'http',
  'https',
  'net',
  'tls',
  'url',
  'querystring',
  'assert',
  'string_decoder',
  'timers',
  'tty',
  'constants',
  'dns',
  'domain',
  'module',
  'process',
  'punycode',
  'repl',
  'vm',
  'worker_threads',
  'perf_hooks',
  'async_hooks',
  'diagnostics_channel',
  'node:stream',
  'node:util',
  'node:path',
  'node:fs',
  'node:os',
  'node:child_process',
  'node:crypto',
  'node:events',
  'node:buffer',
  'node:zlib',
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
  'node:url',
  'node:querystring',
  'node:assert',
  'node:string_decoder',
  'node:timers',
  'node:tty',
  'node:constants',
  'node:dns',
  'node:domain',
  'node:module',
  'node:process',
  'node:punycode',
  'node:repl',
  'node:vm',
  'node:worker_threads',
  'node:perf_hooks',
  'node:async_hooks',
  'node:diagnostics_channel',
];

module.exports = {
  input: 'bin/backup.js',
  output: {
    file: 'dist/backup.js',
    format: 'cjs',
    exports: 'auto',
  },
  external: EXTERNAL,
  plugins: [
    json(),
    nodeResolve({
      preferBuiltins: true,
      // 不解析 external 依赖
      resolveOnly: (module) => !EXTERNAL.includes(module),
    }),
    commonjs({
      // 需要转换的模块
      include: /node_modules/,
    }),
  ],
};
