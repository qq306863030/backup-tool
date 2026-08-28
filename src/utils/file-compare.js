'use strict';

/**
 * 文件比较工具：根据名称/大小/修改时间判断文件是否需要同步
 */

/**
 * 判断本地文件与远程文件是否需要同步（增量备份与增量推送核心逻辑）
 * @param {object|null} remote 远程文件信息 { name, size, mtime }，不存在为 null
 * @param {object|null} local 本地文件信息 { size, mtime }，不存在为 null
 * @param {string[]} compareBy 比较依据数组，可包含 name/size/mtime
 * @returns {boolean} true 表示需要同步
 */
function needsSync(remote, local, compareBy = ['name', 'size', 'mtime']) {
  // 一方不存在，说明需要同步（下载或上传）
  if (!local || !remote) return true;

  for (const key of compareBy) {
    switch (key) {
      case 'name':
        // name 比较：本地存在即认为名称匹配，无需额外处理
        break;
      case 'size':
        if (remote.size !== local.size) return true;
        break;
      case 'mtime':
        if (!sameMtime(remote.mtime, local.mtime)) return true;
        break;
      default:
        break;
    }
  }
  return false;
}

/**
 * 比较两个修改时间是否一致（容差 1 秒，避免时区/精度差异）
 * @param {Date|number|string} a
 * @param {Date|number|string} b
 * @param {number} toleranceMs 容差毫秒数，默认 1000
 * @returns {boolean}
 */
function sameMtime(a, b, toleranceMs = 1000) {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) <= toleranceMs;
}

/**
 * 根据 include/exclude 规则过滤文件列表
 * include 优先于 exclude：先按 include 过滤（只保留匹配的文件），
 * 再在匹配结果中应用 exclude。include 为空则处理全部文件。
 * @param {string[]} filePaths 文件相对路径列表
 * @param {string[]} include 包含规则（glob）
 * @param {string[]} exclude 排除规则（glob）
 * @returns {string[]} 过滤后的文件列表
 */
function filterFiles(filePaths, include = [], exclude = []) {
  const micromatch = require('micromatch');
  let result = filePaths;

  // include 优先：非空则只保留匹配的文件
  if (include && include.length > 0) {
    result = micromatch(result, include);
  }

  // 再应用 exclude
  if (exclude && exclude.length > 0) {
    result = micromatch.not(result, exclude);
  }

  return result;
}

module.exports = { needsSync, sameMtime, filterFiles };
