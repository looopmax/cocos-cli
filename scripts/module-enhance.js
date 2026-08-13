/**
 * 模块增强脚本：dump / load js 文件。
 *
 * - dump：把多个 js 入口（含 require 级联依赖）正向写入一个二进制 block 文件，
 *   同时输出 <output>.manifest 文件，mapping 记录在 manifest 中。
 *   二进制格式：[Header] | [Content Area]，mapping 外置到 manifest。
 *   mapping 中的路径是相对包根目录（baseDir）的相对路径，external 保留裸模块名。
 * - load：从二进制 block 文件 + .manifest 加载还原，通过 root（当前包路径）把
 *   manifest 中的相对路径还原为绝对路径，提供内部 require 执行模块，
 *   external 模块透传给真实的 Node require。
 *
 * 用法（CLI）：
 *   node scripts/module-enhance.js dump <entry.js...> -o out.block [--external a,b]
 *   node scripts/module-enhance.js load out.block [entryId] [--eval] [--root <dir>]
 *   node scripts/module-enhance.js list out.block [--root <dir>]
 *
 * 用法（API）：
 *   const enhance = require('./module-enhance');
 *   enhance.dump({ entries, output, externals, baseDir });   // -> output path, 同时生成 .manifest
 *   const ctx = enhance.load(blockPath, { root });            // -> { require, modules, sourceOf }
 *   ctx.require('dist/api/index.js');
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MAGIC = 'CCPB';
const VERSION = 1;
const HEADER_SIZE = 24;

const FLAG_EXTERNAL = 0x01;
const FLAG_JSON = 0x02;

const NODE_MODULES_PREFIX = '[[node_modules]]:';

/** Node 内置模块集合，dump 时忽略，避免打包 node_modules 中同名 npm 包 */
const builtinModulesSet = new Set(require('module').builtinModules);

/**
 * cc 引擎模块（cc / cc/* / cce:*）由 cc 包（packages/cc-module 的 EngineLoader）
 * 虚拟加载并 patch Module._load 处理，不应进 block，加载时透传原生 require。
 */
function isCcModule(request) {
    return request === 'cc' || request.startsWith('cc/') || request.startsWith('cce:');
}

function isBuiltinModule(request) {
    const base = request.replace(/^node:/, '').split('/')[0];
    return builtinModulesSet.has(base);
}

/** 是否应在 dump 时忽略（内置模块或 cc 引擎模块） */
function isIgnoredModule(request) {
    return isBuiltinModule(request) || isCcModule(request);
}

/** 粗略检测源码是否包含顶层 ESM 语法（import/export），此类模块应透传原生加载器 */
function isEsmSource(source) {
    return /^\s*(?:import\s|export\s)/m.test(source);
}

/** ESM 模块透传时的请求名：[[node_modules]]: 前缀的相对名取包名（含 scoped 包），其余取绝对路径 */
function esmRequestId(resolvedId, mod) {
    const rel = mod && mod.relative;
    if (rel && rel.startsWith(NODE_MODULES_PREFIX)) {
        const parts = rel.slice(NODE_MODULES_PREFIX.length).split('/');
        if (parts[0].startsWith('@')) {
            return parts[0] + '/' + parts[1];
        }
        return parts[0];
    }
    return resolvedId;
}

function normalizeId(p) {
    return p.replace(/\\/g, '/');
}

/**
 * 若文件位于 node_modules 下，返回相对其最近 node_modules 根的路径并加前缀，
 * 例如 [[node_modules]]:fs-extra/lib/index.js（无论实际在几层 node_modules 下，
 * 都扁平化为相对最近 node_modules 根的包路径）。否则返回 null。
 */
function nodeModulesName(file) {
    const norm = normalizeId(file);
    const idx = norm.lastIndexOf('/node_modules/');
    if (idx === -1) return null;
    return NODE_MODULES_PREFIX + norm.slice(idx + '/node_modules/'.length);
}

function isRelative(request) {
    return request === '.' || request === '..' ||
        request.startsWith('./') || request.startsWith('../') ||
        /^[a-zA-Z]:[\\/]/.test(request);
}

function resolveAsFile(p) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    if (fs.existsSync(p + '.js')) return p + '.js';
    if (fs.existsSync(p + '.json')) return p + '.json';
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        if (fs.existsSync(path.join(p, 'index.js'))) return path.join(p, 'index.js');
        if (fs.existsSync(path.join(p, 'index.json'))) return path.join(p, 'index.json');
    }
    return null;
}

function resolvePackage(pkgDir, subPath) {
    if (subPath) {
        return resolveAsFile(path.join(pkgDir, subPath));
    }
    const pkgJson = path.join(pkgDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
            if (pkg.main) {
                const resolved = resolveAsFile(path.join(pkgDir, pkg.main));
                if (resolved) return resolved;
            }
        } catch { /* ignore malformed package.json */ }
    }
    return resolveAsFile(path.join(pkgDir, 'index.js')) || resolveAsFile(pkgDir);
}

function resolveNodeModule(request, parentDir) {
    const parts = request.split('/');
    const hasScope = request.startsWith('@') && parts.length >= 2;
    const pkgName = hasScope ? parts.slice(0, 2).join('/') : parts[0];
    const subPath = parts.slice(hasScope ? 2 : 1).join('/');

    let dir = parentDir;
    while (true) {
        const nm = path.join(dir, 'node_modules', pkgName);
        if (fs.existsSync(nm)) {
            const entry = resolvePackage(nm, subPath);
            if (entry) return entry;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function extractRequires(source) {
    const result = [];
    const re = /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
    let m;
    while ((m = re.exec(source)) !== null) {
        result.push(m[2]);
    }
    return result;
}

/* ------------------------------ dump ------------------------------ */

/**
 * @param {object} options
 * @param {string[]} options.entries 入口文件（相对 baseDir 或绝对路径）
 * @param {string} [options.output] 输出 block 文件路径；不传则按规范命名
 *        .[xxx].module.cache 生成于 dist/ 下（[xxx] 由首个入口转换）
 * @param {string[]} [options.externals] 视为 external 的模块名，不打包
 * @param {string} [options.baseDir] 解析入口的基准目录，默认 cwd
 * @returns {string} 输出文件路径
 */
function dump(options) {
    const {
        entries,
        output,
        externals = [],
        baseDir = process.cwd(),
    } = options;

    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error('[module-enhance] dump requires at least one entry.');
    }

    const resolveCache = new Map();
    const visited = new Set();
    const moduleMap = new Map();
    const pkgDirIdentity = new Map();

    function resolve(request, parentDir) {
        const cacheKey = request + '\0' + parentDir;
        if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey);

        let file = null;
        if (path.isAbsolute(request)) {
            file = resolveAsFile(request);
        } else if (isRelative(request)) {
            file = resolveAsFile(path.resolve(parentDir, request));
        } else {
            file = resolveNodeModule(request, parentDir);
        }

        const result = { id: file ? normalizeId(file) : null, file };
        resolveCache.set(cacheKey, result);
        return result;
    }

    function readModule(file) {
        const abs = path.resolve(file);
        const key = normalizeId(abs);
        if (moduleMap.has(key)) return moduleMap.get(key);

        const isJson = abs.toLowerCase().endsWith('.json');
        const source = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
        const record = { id: key, file: abs, source, isJson, isExternal: false };
        moduleMap.set(key, record);
        return record;
    }

    function registerExternal(name, fromModule) {
        const key = normalizeId(name);
        if (moduleMap.has(key)) return;
        moduleMap.set(key, {
            id: key,
            file: null,
            source: '',
            isJson: false,
            isExternal: true,
            requestedBy: fromModule.id,
        });
    }

    function collectRequires(module, externalsSet, queue) {
        if (module.isJson) return;
        for (const req of extractRequires(module.source)) {
            // 忽略 Node 内置模块与 cc 引擎模块（fs/path/cc 等），不打包
            if (isIgnoredModule(req)) {
                continue;
            }
            if (externalsSet.has(req)) {
                registerExternal(req, module);
                continue;
            }
            const resolved = resolve(req, path.dirname(module.file));
            if (resolved.file) {
                queue.push({ file: resolved.file });
            } else {
                registerExternal(req, module);
            }
        }
    }

    function collect(entryFiles, externalsSet) {
        const queue = entryFiles.map(file => ({ file: path.resolve(file) }));
        while (queue.length) {
            const { file } = queue.shift();
            if (!fs.existsSync(file)) {
                console.warn(`[module-enhance] entry not found, skipped: ${file}`);
                continue;
            }
            const module = readModule(file);
            if (visited.has(module.id)) continue;
            visited.add(module.id);
            collectRequires(module, externalsSet, queue);
        }
    }

    /**
     * 扫描 node_modules（含嵌套）下所有目录的 package.json 并收录进 moduleMap，
     * 同时记录每个包目录及其 name@version 身份（供后续按 name+version 去重）。
     * 跳过与 Node 内置模块同名的包目录（如 npm 的 path/buffer 包）。
     */
    function collectPackageJsons() {
        const queue = [nodeModulesRoot];
        const seen = new Set();
        while (queue.length) {
            const dir = queue.shift();
            if (!dir || seen.has(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
            seen.add(dir);

            const pkgJson = path.join(dir, 'package.json');
            if (fs.existsSync(pkgJson)) {
                try {
                    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
                    // 跳过与 Node 内置模块同名的包（如 npm 的 path/buffer 包）
                    const pkgBase = (pkg.name || '').split('/').pop();
                    if (pkgBase && builtinModulesSet.has(pkgBase)) {
                        continue;
                    }
                    // 跳过 cc 引擎包（EngineLoader 虚拟加载，不进 block）
                    if (pkg.name === '@base/cc' || pkgBase === 'cc') {
                        continue;
                    }
                    const key = (pkg.name || '') + '@' + (pkg.version || '');
                    if (!pkgDirIdentity.has(dir)) {
                        pkgDirIdentity.set(dir, key);
                    }
                    readModule(pkgJson);
                } catch (err) {
                    console.warn(`[module-enhance] failed to read ${pkgJson}: ${err.message}`);
                }
            }

            let entries;
            try {
                entries = fs.readdirSync(dir);
            } catch {
                continue;
            }
            for (const entry of entries) {
                const child = path.join(dir, entry);
                if (fs.existsSync(child) && fs.statSync(child).isDirectory()) {
                    queue.push(child);
                }
            }
        }
    }

    /**
     * 判断目录的 node_modules 嵌套深度（nodeModulesRoot 直属为 0，越深越大）。
     */
    function nodeModulesDepth(dir) {
        const rel = path.relative(nodeModulesRoot, dir);
        if (!rel || rel.startsWith('..')) return Number.MAX_SAFE_INTEGER;
        const parts = rel.split(path.sep);
        let depth = 0;
        for (const part of parts) {
            if (part === 'node_modules') depth += 1;
        }
        return depth;
    }

    /**
     * 查找文件所属的包目录（向上最近含 package.json 的目录）。
     * @returns {string|null} 包目录绝对路径
     */
    function pkgDirOf(file) {
        const normFile = normalizeId(file);
        let best = null;
        for (const dir of pkgDirIdentity.keys()) {
            const normDir = normalizeId(dir);
            if (normFile === normDir || normFile.startsWith(normDir + '/')) {
                if (!best || normDir.length > normalizeId(best).length) {
                    best = dir;
                }
            }
        }
        return best;
    }

    /**
     * 按扁平化后的 node_modules 路径（相对最近 node_modules 根）去重：
     * 同一个包路径（如 [[node_modules]]:fs-extra/lib/index.js）无论来自顶层还是
     * 二级 node_modules，只保留嵌套深度最浅（顶层）的那份，其余副本的所有模块
     * 从 moduleMap 移除。加载时 findModule 会向上 fallback 到保留的顶层副本。
     */
    function dedupeNodeModulesPackages() {
        // 按扁平化 name 分组，每组选嵌套深度最浅的包目录为保留副本
        const byName = new Map();
        for (const [id, rec] of Array.from(moduleMap)) {
            if (rec.isExternal || !rec.file) continue;
            const flatName = nodeModulesName(rec.file);
            if (!flatName) continue;
            if (!byName.has(flatName)) byName.set(flatName, []);
            byName.get(flatName).push({ id, rec });
        }

        const removedIds = new Set();
        for (const [, copies] of byName) {
            if (copies.length <= 1) continue;
            copies.sort((a, b) => {
                const da = nodeModulesDepth(pkgDirOf(a.rec.file) || a.rec.file);
                const db = nodeModulesDepth(pkgDirOf(b.rec.file) || b.rec.file);
                return da - db;
            });
            for (let i = 1; i < copies.length; i++) {
                removedIds.add(copies[i].id);
            }
        }

        for (const id of removedIds) {
            moduleMap.delete(id);
        }

        if (removedIds.size === 0) return;

        console.log(`[module-enhance] dedupe: removed ${removedIds.size} duplicate node_modules module copies.`);
    }

    function buildOutput() {
        const records = Array.from(moduleMap.values());

        const contentChunks = [];
        const manifestMapping = [];
        let contentOffset = 0;

        for (const rec of records) {
            const flags = (rec.isExternal ? FLAG_EXTERNAL : 0) | (rec.isJson ? FLAG_JSON : 0);
            const body = rec.isExternal ? Buffer.alloc(0) : Buffer.from(rec.source, 'utf8');

            // mapping 名称：
            // - external 保留裸模块名
            // - node_modules 下的文件标记 [[node_modules]]: 前缀，路径相对 node_modules 根
            // - 其余记录相对包根目录（resolvedBase）的路径
            let name;
            if (rec.isExternal) {
                name = rec.id;
            } else {
                name = nodeModulesName(rec.file) || normalizeId(path.relative(resolvedBase, rec.file));
            }

            manifestMapping.push({ name, flags, offset: contentOffset, length: body.length });
            contentChunks.push(body);
            contentOffset += body.length;
        }

        const contentSize = contentOffset;
        const contentBuffer = Buffer.concat(contentChunks);

        const header = Buffer.alloc(HEADER_SIZE);
        header.write(MAGIC, 0, 'ascii');
        header.writeUInt16LE(VERSION, 4);
        header.writeUInt8(0, 6);
        header.writeUInt8(0, 7);
        header.writeUInt32LE(records.length, 8);
        header.writeUInt32LE(0, 12); // mapping 已外置到 manifest，二进制内不再包含 mapping 区
        header.writeUInt32LE(contentSize, 16);
        header.writeUInt32LE(HEADER_SIZE, 20);

        const binary = Buffer.concat([header, contentBuffer]);

        const manifest = {
            magic: MAGIC,
            version: VERSION,
            moduleCount: records.length,
            contentSize,
            headerSize: HEADER_SIZE,
            mapping: manifestMapping,
        };

        return { binary, manifest };
    }

    const resolvedBase = path.resolve(baseDir);
    const nodeModulesRoot = path.join(resolvedBase, 'node_modules');
    const externalsSet = new Set(externals);
    const entryFiles = entries.map(e => path.resolve(resolvedBase, e));

    for (const f of entryFiles) {
        if (!fs.existsSync(f)) {
            throw new Error(`[module-enhance] entry not found: ${f}`);
        }
    }

    collect(entryFiles, externalsSet);
    collectPackageJsons();
    dedupeNodeModulesPackages();

    // 默认输出命名规范：.[xxx].module.cache，生成于 dist/ 下。
    // [xxx] 由首个入口相对 baseDir 的路径转换而来（去扩展名，/ 和 . 替换为 -）。
    const defaultOutputPath = (() => {
        const rel = normalizeId(path.relative(resolvedBase, entryFiles[0]));
        const noExt = rel.replace(/\.(?:js|mjs|cjs|json)$/i, '');
        const xxx = noExt.replace(/[/.]/g, '-');
        return path.join(resolvedBase, 'dist', `.${xxx}.module.cache`);
    })();

    const { binary, manifest } = buildOutput();
    const outputPath = path.resolve(output || defaultOutputPath);
    const manifestPath = outputPath + '.manifest';
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, binary);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2));

    const externalCount = Array.from(moduleMap.values()).filter(r => r.isExternal).length;
    console.log(`[module-enhance] dumped ${moduleMap.size} modules -> ${outputPath} (${binary.length} bytes, ${externalCount} externals)`);
    console.log(`[module-enhance] manifest written -> ${manifestPath} (${manifest.mapping.length} entries)`);

    return outputPath;
}

/* ------------------------------ load ------------------------------ */

/**
 * 解析 block 二进制头部 + mapping。
 * mapping 优先从 <block>.manifest 读取；如果不存在 manifest，
 * 则回退解析二进制内嵌的 mapping 区（旧格式）。
 * @param {Buffer} buf block 二进制内容
 * @param {string|null} manifestPath manifest 文件路径
 * @param {string} [root] 当前包根路径，用于将 manifest 中的相对路径还原为绝对路径
 * @returns {{ version, moduleCount, mappingSize, contentSize, tableOffset,
 *              contentStart, modules: Map<string, {flags, offset, length, relative?}> }}
 */
function parseBlock(buf, manifestPath, root) {
    if (buf.length < HEADER_SIZE || buf.toString('ascii', 0, 4) !== MAGIC) {
        throw new Error('[module-enhance] not a valid CCPB block file.');
    }
    const version = buf.readUInt16LE(4);
    const moduleCount = buf.readUInt32LE(8);
    const mappingSize = buf.readUInt32LE(12);
    const contentSize = buf.readUInt32LE(16);
    const tableOffset = buf.readUInt32LE(20);
    const contentStart = tableOffset + mappingSize;

    let modules;
    if (manifestPath && fs.existsSync(manifestPath)) {
        modules = parseManifestFile(manifestPath, root);
    } else if (mappingSize > 0) {
        modules = parseMappingArea(buf, tableOffset, mappingSize, moduleCount);
    } else {
        throw new Error('[module-enhance] no mapping found: missing manifest file or empty mapping area.');
    }

    return { version, moduleCount: modules.size, mappingSize, contentSize, tableOffset, contentStart, modules };
}

/**
 * manifest 中的 name 是相对包根的路径（external 为裸模块名），
 * 加载时用 root 把相对路径还原成绝对路径作为模块 key。
 */
function parseManifestFile(manifestPath, root) {
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (data.magic !== MAGIC || !Array.isArray(data.mapping)) {
        throw new Error(`[module-enhance] invalid manifest file: ${manifestPath}`);
    }
    const modules = new Map();
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

/**
 * 还原 manifest 中的 name 为绝对 key：
 * - external 模块保留裸模块名；
 * - [[node_modules]]: 前缀的节点用 root/node_modules 拼接；
 * - 其余相对路径拼接 root。
 */
function resolveModuleKey(name, flags, root) {
    if (flags & FLAG_EXTERNAL) return name;
    if (name.startsWith(NODE_MODULES_PREFIX)) {
        const rel = name.slice(NODE_MODULES_PREFIX.length);
        return root ? normalizeId(path.resolve(root, 'node_modules', rel)) : name;
    }
    if (root && !path.isAbsolute(name)) return normalizeId(path.resolve(root, name));
    return normalizeId(name);
}

function parseMappingArea(buf, tableOffset, mappingSize, moduleCount) {
    const modules = new Map();
    let o = tableOffset;
    const end = tableOffset + mappingSize;
    for (let i = 0; i < moduleCount; i++) {
        if (o + 2 > end) throw new Error('[module-enhance] mapping area corrupted.');
        const nameLen = buf.readUInt16LE(o); o += 2;
        if (o + nameLen > end) throw new Error('[module-enhance] mapping area corrupted.');
        const name = buf.toString('utf8', o, o + nameLen); o += nameLen;
        if (o + 1 + 8 > end) throw new Error('[module-enhance] mapping area corrupted.');
        const flags = buf.readUInt8(o); o += 1;
        const offset = buf.readUInt32LE(o); o += 4;
        const length = buf.readUInt32LE(o); o += 4;
        modules.set(name, { flags, offset, length });
    }
    if (o !== end) {
        throw new Error('[module-enhance] mapping area size mismatch.');
    }
    return modules;
}

/**
 * 从二进制 block 文件加载还原模块。
 * @param {string|Buffer} blockFileOrBuffer block 文件路径或已读取的 Buffer
 * @param {object} [options]
 * @param {string} [options.manifest] manifest 文件路径，默认取 <block>.manifest
 * @param {string} [options.root] 当前包根路径，用于把 manifest 中的相对路径还原为绝对路径；
 *        默认取 block 文件所在目录的上一级（即包根）
 * @param {(id: string) => any} [options.externalLoader] external 模块的自定义加载器，
 *        默认使用 Node 原生 require
 * @returns {{
 *     require: (id: string) => any,
 *     modules: () => string[],
 *     sourceOf: (id: string) => string,
 *     info: object,
 * }}
 */
function load(blockFileOrBuffer, options = {}) {
    const buf = Buffer.isBuffer(blockFileOrBuffer)
        ? blockFileOrBuffer
        : fs.readFileSync(blockFileOrBuffer);

    const manifestPath = options.manifest
        || (Buffer.isBuffer(blockFileOrBuffer) ? null : blockFileOrBuffer + '.manifest');

    let root = options.root;
    if (!root && !Buffer.isBuffer(blockFileOrBuffer)) {
        // 默认以 block 文件所在目录的父目录作为包根（如 dist/dist-api-index.module.block -> 包根）
        root = path.dirname(path.dirname(path.resolve(blockFileOrBuffer)));
    }

    const info = parseBlock(buf, manifestPath, root);
    const externalLoader = options.externalLoader || ((id) => require(id));

    const cache = new Map();

    function contentOf(mod) {
        return buf.toString('utf8', info.contentStart + mod.offset, info.contentStart + mod.offset + mod.length);
    }

    function findModule(request, fromDir) {
        // cc 引擎模块由 EngineLoader 虚拟加载，不在 block 内解析
        if (isCcModule(request)) return null;

        const candidates = [];

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
                    const pkg = JSON.parse(contentOf(pkgMod));
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

    function executeModule(id) {
        // 支持相对入口 id：若不能直接命中，则基于包根 root 解析
        let resolvedId = id;
        if (!info.modules.has(resolvedId) && root && !path.isAbsolute(resolvedId) && !(info.modules.get(resolvedId) && info.modules.get(resolvedId).flags & FLAG_EXTERNAL)) {
            const fromRoot = resolveModuleKey(resolvedId, 0, root);
            if (info.modules.has(fromRoot)) {
                resolvedId = fromRoot;
            } else {
                const found = findModule(resolvedId, root);
                if (found) resolvedId = found;
            }
        }

        if (cache.has(resolvedId)) return cache.get(resolvedId).exports;

        const mod = info.modules.get(resolvedId);
        if (!mod) {
            throw new Error(`[module-enhance] module not found in block: ${resolvedId}`);
        }

        if (mod.flags & FLAG_EXTERNAL) {
            const value = externalLoader(resolvedId);
            cache.set(resolvedId, { exports: value });
            return value;
        }

        // ESM 源码无法用 new Function(CommonJS) 执行，透传给 Node 原生加载器。
        // 使用包名让 require 按 Node 语义加载。
        if (isEsmSource(contentOf(mod))) {
            const value = externalLoader(esmRequestId(resolvedId, mod));
            cache.set(resolvedId, { exports: value });
            return value;
        }

        const m = { id: resolvedId, exports: {}, loaded: false };
        cache.set(resolvedId, m);

        if (mod.flags & FLAG_JSON) {
            m.exports = JSON.parse(contentOf(mod));
            m.loaded = true;
            return m.exports;
        }

        const dir = path.dirname(resolvedId);

        function localRequire(request) {
            const resolved = findModule(request, dir);
            if (resolved) {
                return executeModule(resolved);
            }
            // 不在 block 内（含 .node 原生绑定、动态 require 等）：透传给 Node，
            // 相对路径基于当前模块目录 dir 解析
            const externalId = path.isAbsolute(request) || isRelative(request)
                ? path.resolve(dir, request)
                : request;
            return externalLoader(externalId);
        }
        localRequire.resolve = (request) => {
            const resolved = findModule(request, dir);
            return resolved || require.resolve(request);
        };
        localRequire.cache = cache;

        const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', contentOf(mod));
        fn.call(m.exports, m.exports, localRequire, m, resolvedId, dir);
        m.loaded = true;
        return m.exports;
    }

    return {
        require: executeModule,
        modules: () => Array.from(info.modules.keys()),
        sourceOf: (id) => {
            let resolvedId = id;
            if (!info.modules.has(resolvedId) && root && !path.isAbsolute(resolvedId)) {
                resolvedId = resolveModuleKey(resolvedId, 0, root);
            }
            const mod = info.modules.get(resolvedId);
            if (!mod) {
                throw new Error(`[module-enhance] module not found in block: ${resolvedId}`);
            }
            return contentOf(mod);
        },
        info,
    };
}

/* ------------------------------ list ------------------------------ */

function list(blockFileOrBuffer, options = {}) {
    const buf = Buffer.isBuffer(blockFileOrBuffer)
        ? blockFileOrBuffer
        : fs.readFileSync(blockFileOrBuffer);
    const manifestPath = options.manifest
        || (Buffer.isBuffer(blockFileOrBuffer) ? null : blockFileOrBuffer + '.manifest');
    let root = options.root;
    if (!root && !Buffer.isBuffer(blockFileOrBuffer)) {
        root = path.dirname(path.dirname(path.resolve(blockFileOrBuffer)));
    }
    const info = parseBlock(buf, manifestPath, root);

    for (const [name, mod] of info.modules) {
        const kind = (mod.flags & FLAG_EXTERNAL)
            ? 'external'
            : ((mod.flags & FLAG_JSON) ? 'json' : 'js');
        console.log(`${kind.padEnd(8)} ${String(mod.length).padStart(8)}  ${name}`);
    }
    console.log('');
    console.log(
        `[module-enhance] version: ${info.version}, modules: ${info.moduleCount}, ` +
        `mapping: ${info.mappingSize} B, content: ${info.contentSize} B, total: ${buf.length} B`,
    );
}

/* ------------------------------ CLI ------------------------------ */

function printHelp() {
    console.log(`
Usage:
  node scripts/module-enhance.js dump <entry.js...> [-o <output>] [--external a,b] [--base-dir <dir>]
  node scripts/module-enhance.js load <output> [entryId] [--eval] [--root <dir>]
  node scripts/module-enhance.js list <output> [--root <dir>]

Commands:
  dump   Pack multiple JS entries (and require dependency graph) into a binary block.
         Also writes <output>.manifest which holds the module mapping (paths are
         relative to the package root).
  load   Load a binary block back (using its .manifest mapping); require <entryId>
         and (unless --eval) print its exports.
  list   List modules of a binary block (using its .manifest mapping).

Output naming (dump):
  Defaults to .[xxx].module.cache under dist/, where [xxx] is derived from the
  first entry (e.g. dist/api/index.js -> .dist-api-index.module.cache).

Options:
  -o, --output <file>    Output block path (dump, optional; default: .[xxx].module.cache under dist/)
  -e, --external <names> Comma separated module names treated as external (dump)
  -b, --base-dir <dir>   Package root for resolving entries (dump, default: cwd);
                         mapping paths are stored relative to it
  -m, --manifest <file>  Manifest file path (load/list, default: <block>.manifest)
      --root <dir>       Package root to prepend to relative mapping paths
                         (load/list, default: parent of block dir)
      --eval             Only require the entry, do not print exports (load)
  -h, --help             Show this help
`);
}

function main() {
    const argv = process.argv.slice(2);
    const opts = { cmd: null, entries: [], externals: [], output: '', baseDir: process.cwd(), manifest: '', root: '', eval: false, help: false };

    let args = argv.slice();
    if (args.length && !args[0].startsWith('-')) {
        opts.cmd = args[0];
        args = args.slice(1);
    }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '-o': case '--output':
                opts.output = args[++i];
                break;
            case '-e': case '--external':
                for (const name of (args[++i] || '').split(',')) {
                    const trimmed = name.trim();
                    if (trimmed) opts.externals.push(trimmed);
                }
                break;
            case '-b': case '--base-dir':
                opts.baseDir = args[++i];
                break;
            case '-m': case '--manifest':
                opts.manifest = args[++i];
                break;
            case '-r': case '--root':
                opts.root = args[++i];
                break;
            case '--eval':
                opts.eval = true;
                break;
            case '-h': case '--help':
                opts.help = true;
                break;
            default:
                if (arg.startsWith('-')) {
                    console.error(`[module-enhance] unknown option: ${arg}`);
                    opts.help = true;
                } else {
                    opts.entries.push(arg);
                }
        }
    }

    if (opts.help || !opts.cmd) {
        printHelp();
        process.exit(opts.help ? 0 : 1);
    }

    if (opts.cmd === 'dump') {
        dump({
            entries: opts.entries,
            output: opts.output,
            externals: opts.externals,
            baseDir: opts.baseDir,
        });
    } else if (opts.cmd === 'list') {
        list(opts.entries[0], { manifest: opts.manifest || undefined, root: opts.root || undefined });
    } else if (opts.cmd === 'load') {
        const blockFile = opts.entries[0];
        if (!blockFile) {
            console.error('[module-enhance] missing block file for load.');
            process.exit(1);
        }
        const ctx = load(blockFile, { manifest: opts.manifest || undefined, root: opts.root || undefined });
        const entryId = opts.entries[1];
        if (!entryId) {
            console.log('[module-enhance] block loaded. Available modules:');
            ctx.modules().forEach(id => console.log('  ' + id));
            return;
        }
        const value = ctx.require(entryId);
        if (!opts.eval) {
            console.log(`[module-enhance] exports of ${entryId}:`);
            console.dir(value, { depth: 2 });
        }
    } else {
        console.error(`[module-enhance] unknown command: ${opts.cmd}`);
        process.exit(1);
    }
}

module.exports = { dump, load, list, parseBlock };

if (require.main === module) {
    main();
}
