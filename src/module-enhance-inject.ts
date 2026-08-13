/**
 * 模块增强注入：加载 block 文件并把其中的模块注入 Node 的 require.cache，
 * 从而优化加载效率（单个二进制块读取内存，避免逐文件磁盘 I/O 与重复编译）。
 *
 * 本模块「加载即执行」：import 时自动读取 <packageRoot>/dist/dist-api-index.module.block
 * （含 .manifest），拦截 Module._load，使 block 内模块从内存执行并写入 require.cache，
 * 后续 require 直接命中缓存；不在 block 内的模块透传给原始 Node 加载器。
 *
 * 用法：
 *   import './module-enhance-inject';   // 自动注入，无需调用
 *
 * 或手动指定 block 文件：
 *   import { injectBlock } from './module-enhance-inject';
 *   const ctx = injectBlock('path/to/xxx.module.block');
 */

import * as fs from 'fs';
import * as path from 'path';

const builtinModulesSet: ReadonlySet<string> = new Set(require('module').builtinModules as string[]);

const MAGIC = 'CCPB';
const HEADER_SIZE = 24;

const FLAG_EXTERNAL = 0x01;
const FLAG_JSON = 0x02;

const NODE_MODULES_PREFIX = '[[node_modules]]:';

interface BlockModuleEntry {
    flags: number;
    offset: number;
    length: number;
    relative?: string;
}

interface BlockInfo {
    version: number;
    moduleCount: number;
    mappingSize: number;
    contentSize: number;
    tableOffset: number;
    contentStart: number;
    modules: Map<string, BlockModuleEntry>;
}

interface InjectContext {
    require: (id: string) => any;
    modules: () => string[];
    sourceOf: (id: string) => string;
    info: BlockInfo;
    restore: () => void;
}

function normalizeId(p: string): string {
    return p.replace(/\\/g, '/');
}

function isRelative(request: string): boolean {
    return request === '.' || request === '..' ||
        request.startsWith('./') || request.startsWith('../') ||
        /^[a-zA-Z]:[\\/]/.test(request);
}

function isBuiltinModule(request: string): boolean {
    const base = request.split('/')[0];
    return builtinModulesSet.has(base);
}

/**
 * cc 引擎模块（cc / cc/* / cce:*）由 cc 包（packages/cc-module 的 EngineLoader）
 * 虚拟加载并 patch Module._load 处理，不应从 block 解析，透传原生 require。
 */
function isCcModule(request: string): boolean {
    return request === 'cc' || request.startsWith('cc/') || request.startsWith('cce:');
}

/**
 * 粗略检测源码是否包含顶层 ESM 语法（import/export）。
 * 此类模块无法用 new Function 以 CommonJS 方式执行，应透传原生加载器。
 */
function isEsmSource(source: string): boolean {
    return /^\s*(?:import\s|export\s)/m.test(source);
}

/**
 * ESM 模块透传时的请求名：
 * - [[node_modules]]: 前缀的相对名取包名（如 replace-in-file/index.js -> replace-in-file，
 *   @rollup/plugin-commonjs/dist/... -> @rollup/plugin-commonjs）
 * - 其余取相对名或绝对路径
 */
function esmRequestId(resolvedId: string, mod: BlockModuleEntry): string {
    const rel = mod.relative;
    if (rel && rel.startsWith(NODE_MODULES_PREFIX)) {
        const parts = rel.slice(NODE_MODULES_PREFIX.length).split('/');
        if (parts[0].startsWith('@')) {
            return parts[0] + '/' + parts[1];
        }
        return parts[0];
    }
    return resolvedId;
}

/**
 * 还原 manifest 中的 name 为绝对 key：
 * - external 模块保留裸模块名；
 * - [[node_modules]]: 前缀的节点用 root/node_modules 拼接；
 * - 其余相对路径拼接 root。
 */
function resolveModuleKey(name: string, flags: number, root: string | undefined): string {
    if (flags & FLAG_EXTERNAL) return name;
    if (name.startsWith(NODE_MODULES_PREFIX)) {
        const rel = name.slice(NODE_MODULES_PREFIX.length);
        return root ? normalizeId(path.resolve(root, 'node_modules', rel)) : name;
    }
    if (root && !path.isAbsolute(name)) return normalizeId(path.resolve(root, name));
    return normalizeId(name);
}

function parseManifestFile(manifestPath: string, root?: string): Map<string, BlockModuleEntry> {
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        magic: string;
        mapping: { name: string; flags: number; offset: number; length: number }[];
    };
    if (data.magic !== MAGIC || !Array.isArray(data.mapping)) {
        throw new Error(`[module-enhance-inject] invalid manifest file: ${manifestPath}`);
    }
    const modules = new Map<string, BlockModuleEntry>();
    for (const entry of data.mapping) {
        const key = resolveModuleKey(entry.name, entry.flags, root);
        modules.set(key, {
            flags: entry.flags,
            offset: entry.offset,
            length: entry.length,
            relative: entry.name,
        });
    }
    return modules;
}

function parseMappingArea(
    buf: Buffer,
    tableOffset: number,
    mappingSize: number,
    moduleCount: number,
): Map<string, BlockModuleEntry> {
    const modules = new Map<string, BlockModuleEntry>();
    let o = tableOffset;
    const end = tableOffset + mappingSize;
    for (let i = 0; i < moduleCount; i++) {
        if (o + 2 > end) throw new Error('[module-enhance-inject] mapping area corrupted.');
        const nameLen = buf.readUInt16LE(o); o += 2;
        if (o + nameLen > end) throw new Error('[module-enhance-inject] mapping area corrupted.');
        const name = buf.toString('utf8', o, o + nameLen); o += nameLen;
        if (o + 1 + 8 > end) throw new Error('[module-enhance-inject] mapping area corrupted.');
        const flags = buf.readUInt8(o); o += 1;
        const offset = buf.readUInt32LE(o); o += 4;
        const length = buf.readUInt32LE(o); o += 4;
        modules.set(name, { flags, offset, length });
    }
    if (o !== end) {
        throw new Error('[module-enhance-inject] mapping area size mismatch.');
    }
    return modules;
}

function parseBlock(buf: Buffer, manifestPath: string | null, root?: string): BlockInfo {
    if (buf.length < HEADER_SIZE || buf.toString('ascii', 0, 4) !== MAGIC) {
        throw new Error('[module-enhance-inject] not a valid CCPB block file.');
    }
    const version = buf.readUInt16LE(4);
    const moduleCount = buf.readUInt32LE(8);
    const mappingSize = buf.readUInt32LE(12);
    const contentSize = buf.readUInt32LE(16);
    const tableOffset = buf.readUInt32LE(20);
    const contentStart = tableOffset + mappingSize;

    let modules: Map<string, BlockModuleEntry>;
    if (manifestPath && fs.existsSync(manifestPath)) {
        modules = parseManifestFile(manifestPath, root);
    } else if (mappingSize > 0) {
        modules = parseMappingArea(buf, tableOffset, mappingSize, moduleCount);
    } else {
        throw new Error('[module-enhance-inject] no mapping found: missing manifest file or empty mapping area.');
    }

    return { version, moduleCount: modules.size, mappingSize, contentSize, tableOffset, contentStart, modules };
}

/**
 * 加载 block 文件并把模块注入 require.cache。
 * @param {string} blockFile block 文件路径
 * @param {object} [options]
 * @param {string} [options.manifest] manifest 文件路径，默认取 <block>.manifest
 * @param {string} [options.root] 当前包根路径，默认取 block 文件所在目录的父目录
 * @param {(id: string) => any} [options.externalLoader] external 模块的自定义加载器，默认 Node require
 */
export function injectBlock(blockFile: string, options: {
    manifest?: string;
    root?: string;
    externalLoader?: (id: string) => any;
} = {}): InjectContext {
    const buf = fs.readFileSync(blockFile);
    const manifestPath = options.manifest || blockFile + '.manifest';
    const root = options.root || path.dirname(path.dirname(path.resolve(blockFile)));
    const info = parseBlock(buf, manifestPath, root);

    // 透传用原生 require：它走当前生效的 Module._load（EngineLoader 处理 cc 引擎模块），
    // 且 block 模块间通过 localRequire 互连，无需全局 patch Module._load。
    const externalLoader = options.externalLoader || ((id: string) => require(id));

    const Module = require('module') as any;
    const execCache = new Map<string, any>();
    const moduleCache = Module._cache as Record<string, any>;

    function contentOf(mod: BlockModuleEntry): string {
        return buf.toString('utf8', info.contentStart + mod.offset, info.contentStart + mod.offset + mod.length);
    }

    function findModule(request: string, fromDir: string): string | null {
        if (isBuiltinModule(request)) return null;
        // cc 引擎模块由 EngineLoader 虚拟加载，不在 block 内解析
        if (isCcModule(request)) return null;

        const candidates: string[] = [];

        if (path.isAbsolute(request)) {
            candidates.push(request);
        } else if (isRelative(request)) {
            candidates.push(path.resolve(fromDir, request));
        } else {
            let dir = fromDir;
            while (true) {
                candidates.push(path.join(dir, 'node_modules', request));
                const parent = path.dirname(dir);
                if (parent === dir) break;
                dir = parent;
            }
            candidates.push(request);
        }

        for (const c of candidates) {
            const normalized = normalizeId(c);
            if (info.modules.has(normalized)) return normalized;
            if (info.modules.has(normalized + '.js')) return normalized + '.js';
            if (info.modules.has(normalized + '.json')) return normalized + '.json';
            const indexJs = normalized.replace(/\/?$/, '/index.js');
            if (info.modules.has(indexJs)) return indexJs;
            const indexJson = normalized.replace(/\/?$/, '/index.json');
            if (info.modules.has(indexJson)) return indexJson;
            if (info.modules.has(normalized + '/index.js')) return normalized + '/index.js';
            if (info.modules.has(normalized + '/index.json')) return normalized + '/index.json';

            // 若该路径是 node_modules 中的包目录，尝试用记录的 package.json main 解析
            const pkgJson = normalized.replace(/\/?$/, '/package.json');
            const pkgMod = info.modules.get(pkgJson);
            if (pkgMod && (pkgMod.flags & FLAG_JSON)) {
                try {
                    const pkg = JSON.parse(contentOf(pkgMod)) as { main?: string };
                    if (pkg.main) {
                        const mainBase = path.posix.join(normalized, pkg.main);
                        if (info.modules.has(mainBase)) return mainBase;
                        if (info.modules.has(mainBase + '.js')) return mainBase + '.js';
                        if (info.modules.has(mainBase + '.json')) return mainBase + '.json';
                    }
                } catch { /* ignore malformed package.json */ }
            }
        }
        return null;
    }

    function executeFromBlock(id: string): any {
        // 支持相对入口 id：若不能直接命中，则基于包根 root 解析
        let resolvedId = id;
        if (!info.modules.has(resolvedId) && root && !path.isAbsolute(resolvedId)) {
            const fromRoot = resolveModuleKey(resolvedId, 0, root);
            if (info.modules.has(fromRoot)) {
                resolvedId = fromRoot;
            } else {
                const found = findModule(resolvedId, root);
                if (found) resolvedId = found;
            }
        }

        if (execCache.has(resolvedId)) return execCache.get(resolvedId).exports;
        // 若已由原生 require.cache 命中，直接复用
        if (moduleCache[resolvedId] && moduleCache[resolvedId].loaded) {
            return moduleCache[resolvedId].exports;
        }

        const mod = info.modules.get(resolvedId);
        if (!mod) {
            throw new Error(`[module-enhance-inject] module not found in block: ${resolvedId}`);
        }

        if (mod.flags & FLAG_EXTERNAL) {
            const value = externalLoader(resolvedId);
            execCache.set(resolvedId, { exports: value });
            return value;
        }

        // ESM 源码无法用 new Function(CommonJS) 执行，透传给 Node 原生加载器。
        // 使用包名（[[node_modules]]: 前缀后的第一段）让 require 按 Node 语义加载。
        if (isEsmSource(contentOf(mod))) {
            const value = externalLoader(esmRequestId(resolvedId, mod));
            execCache.set(resolvedId, { exports: value });
            return value;
        }

        const m = { id: resolvedId, exports: {}, loaded: false };
        execCache.set(resolvedId, m);

        if (mod.flags & FLAG_JSON) {
            m.exports = JSON.parse(contentOf(mod));
            m.loaded = true;
            return m.exports;
        }

        const dir = path.dirname(resolvedId);

        function localRequire(request: string): any {
            const resolved = findModule(request, dir);
            if (resolved) {
                return executeFromBlock(resolved);
            }
            // 不在 block 内（含 .node 原生绑定、动态 require 等）：透传给 Node，
            // 相对路径基于当前模块目录 dir 解析
            const externalId = path.isAbsolute(request) || isRelative(request)
                ? path.resolve(dir, request)
                : request;
            return externalLoader(externalId);
        }
        localRequire.resolve = (request: string) => {
            const resolved = findModule(request, dir);
            return resolved || (require as any).resolve(path.resolve(dir, request));
        };
        localRequire.cache = execCache;

        const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', contentOf(mod));
        fn.call(m.exports, m.exports, localRequire, m, resolvedId, dir);
        m.loaded = true;

        // 写入 Node require.cache，使后续原生 require 直接命中
        const cacheEntry = moduleCache[resolvedId] || (moduleCache[resolvedId] = {});
        cacheEntry.id = resolvedId;
        cacheEntry.filename = resolvedId;
        cacheEntry.path = path.dirname(resolvedId);
        cacheEntry.exports = m.exports;
        cacheEntry.loaded = true;
        cacheEntry.children = cacheEntry.children || [];

        return m.exports;
    }

    /**
     * 无全局拦截：block 注入不 patch Module._load，避免与 cc 的 EngineLoader
     * 及其它加载器冲突。已执行模块的结果写入 require.cache，外部原生 require
     * 命中缓存即加速；未命中则走正常磁盘加载。
     */
    function patchModuleLoad(): () => void {
        return () => { /* no-op */ };
    }
    const restore = patchModuleLoad();

    return {
        require: executeFromBlock,
        modules: () => Array.from(info.modules.keys()),
        sourceOf: (id: string) => {
            const mod = info.modules.get(id);
            if (!mod) {
                throw new Error(`[module-enhance-inject] module not found in block: ${id}`);
            }
            return contentOf(mod);
        },
        info,
        restore,
    };
}

/* ------------------------------ 加载即执行 ------------------------------ */

const DEFAULT_BLOCK_FILE = path.join(__dirname, '.dist-api-index.module.cache');

/**
 * 自动注入：读取默认 block 文件（dist/.dist-api-index.module.cache），
 * 若存在则立即注入 require.cache 并返回上下文，否则返回 null。
 */
export const injected: InjectContext | null = (() => {
    if (!fs.existsSync(DEFAULT_BLOCK_FILE)) {
        return null;
    }
    try {
        return injectBlock(DEFAULT_BLOCK_FILE);
    } catch (err) {
        console.error('[module-enhance-inject] failed to auto-inject block:', err);
        return null;
    }
})();

export { MAGIC, HEADER_SIZE, FLAG_EXTERNAL, FLAG_JSON, NODE_MODULES_PREFIX };
export type { BlockInfo, InjectContext };
