/**
 * 一些全局路径配置记录
 */

import { join } from 'path';
import { existsSync } from 'fs';

/**
 * 解析项目根目录。
 *
 * 兼容两种加载形态：
 *  - tsc 散文件：dist/global.js 的 __dirname 为 dist，项目根为 ../.. ？不，是 ..。
 *  - esbuild bundle：dist/bundle/*.js 的 __dirname 为 dist/bundle，项目根为 ../..。
 *
 * 通过探测包含 package.json 的最近目录来确定，保证两种形态都正确。
 */
function resolveProjectRoot(): string {
    const candidates = [
        join(__dirname, '..'),
        join(__dirname, '..', '..'),
        join(__dirname, '..', '..', '..'),
    ];
    for (const candidate of candidates) {
        if (existsSync(join(candidate, 'package.json'))) {
            return candidate;
        }
    }
    // 兜底：cwd
    return process.cwd();
}

export const projectRoot = resolveProjectRoot();
export const distRoot = join(projectRoot, 'dist');

export const GlobalPaths = {
    staticDir: join(projectRoot, 'static'),
    workspace: projectRoot,
    enginePath: join(projectRoot, 'packages', 'engine'),
};

/**
 * CLI 的任务模式
 */
type CLITaskMode = 'hold' | 'simple';

interface IGlobalConfig {
    mode: CLITaskMode;
}

export const GlobalConfig: IGlobalConfig = {
    mode: 'hold',
};