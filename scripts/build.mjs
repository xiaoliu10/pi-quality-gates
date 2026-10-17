/**
 * 构建：esbuild 打包成 ESM dist（单文件入口，零运行时依赖）。
 * 源码 import 带 .ts 后缀（dev 时 tsc/vitest 直跑需要），esbuild 的 resolve
 * 会自动处理；产物体积小、加载快，pi 装包后直接用。
 */
import { build } from 'esbuild';
import { readdirSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 源码里除入口外对外暴露的子路径（core 是给宿主复用的宿主无关层）。 */
const entries = {
  'index.js': 'index.ts',
  'core/settle.js': 'src/core/settle.ts',
  'core/runner.js': 'src/core/runner.ts',
};

for (const [out, entry] of Object.entries(entries)) {
  const outPath = path.join(root, 'dist', out);
  mkdirSync(path.dirname(outPath), { recursive: true });
  await build({
    entryPoints: [path.join(root, entry)],
    outfile: outPath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: true,
    // node 内置模块保持 external（不打包进 dist）
    external: ['node:fs', 'node:path', 'node:child_process', 'node:url', 'node:os', 'node:util'],
    logLevel: 'info',
  });
}
console.log('build ok:', Object.keys(entries).join(', '));
