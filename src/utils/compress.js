'use strict';

const fs = require('fs');
const path = require('path');
const { ZipArchive } = require('archiver');

/**
 * 压缩工具：统一使用 zip 格式
 */

/**
 * 将目录压缩为 zip 文件
 * @param {string} sourceDir 要压缩的源目录
 * @param {string} zipPath 输出的 zip 文件路径
 * @param {string[]} [exclude] 排除规则（glob）
 * @returns {Promise<string>} zip 文件路径
 */
function zipDirectory(sourceDir, zipPath, exclude = []) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on('close', () => resolve(zipPath));
    output.on('error', (err) => reject(err));
    archive.on('error', (err) => reject(err));
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        // 忽略不存在的文件警告
      } else {
        reject(err);
      }
    });

    archive.pipe(output);

    const baseName = path.basename(sourceDir);
    archive.glob('**/*', {
      cwd: sourceDir,
      dot: true,
      ignore: exclude,
    }, { prefix: baseName });

    archive.finalize();
  });
}

module.exports = { zipDirectory };
