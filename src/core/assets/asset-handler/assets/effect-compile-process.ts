/**
 * Child-process entry point for effect shader compilation. The parent sends
 * only source text and database paths; the compiler and its parser stay out
 * of the asset-db event loop.
 *
 * 子进程在启动时根据父进程传入的 CC_ENGINE_ROOT/CC_ENGINE_DEV 初始化 cc 引擎加载器
 * （EngineLoader），使 `require('cc/editor/offline-mappings')` 等引擎代理模块能解析
 * 到真实引擎产物（磁盘上只有 packages/cc-module/editor/*.js 代理，真实模块由
 * EngineLoader 虚拟加载）。
 */
import * as path from 'path';
import { pathExistsSync, readFileUtf8Sync } from '../../../filesystem';
import { relative, resolve } from 'path';

export interface IEffectCompileRequest {
    type: 'build-effect';
    id: number;
    name: string;
    content: string;
    chunkTargets: string[];
    chunkRoot: string;
    sourceDirectory: string;
}

export interface IEffectAddChunkRequest {
    type: 'add-chunk';
    id: number;
    name: string;
    content: string;
}

export interface IEffectCompileResult {
    type: 'result';
    id: number;
    value: unknown;
}

export interface IEffectCompileError {
    type: 'error';
    id: number;
    message: string;
    stack?: string;
}

interface IEffectCompileState {
    chunkRoot: string;
    sourceDirectory: string;
    chunkTargets: string[];
}

const state: IEffectCompileState = {
    chunkRoot: '',
    sourceDirectory: '',
    chunkTargets: [],
};

/**
 * 初始化 cc 引擎加载环境，使 effect-compiler 能解析 cc/editor/* 引擎模块，
 * 然后加载 effect-compiler 并返回其 API。引擎 dev 路径由父进程通过环境变量传入。
 */
async function loadEffectCompiler() {
    const engineRoot = process.env.CC_ENGINE_ROOT;
    const engineDevPath = process.env.CC_ENGINE_DEV;

    if (engineRoot && engineDevPath) {
        try {
            // 模拟 cc/preload 的环境设置
            (globalThis as any).CC_EDITOR = false;
            (globalThis as any).CC_PREVIEW = false;
            (globalThis as any).window = globalThis;

            if (!(globalThis as any).EditorExtends) {
                try {
                    // dist/core/assets/asset-handler/assets -> dist/core/engine/editor-extends
                    (globalThis as any).EditorExtends = require(path.join(__dirname, '../../../engine/editor-extends/index.js'));
                } catch {
                    // 缺少 EditorExtends 时引擎模块可能无法加载，但不阻塞
                }
            }

            // 预置 gl stub：dev-cli loader 加载引擎时探测 WebGL 后端会 require('gl')。
            // 在无 GPU / ABI 不匹配的环境下真实 gl 无法加载，注入一个可调用的 stub 兜底；
            // 若真实 gl 可加载（Electron 环境）则使用真实实现。
            try {
                const glModule = require('gl');
                if (typeof glModule !== 'function') {
                    throw new Error('gl is not callable');
                }
            } catch {
                // 真实 gl 不可用，注入 stub（shdc-lib 的 finalTypeCheck 会调用 require('gl')(w,h,opts)）
                const glStub = (() => {
                    const ctx = {
                        getSupportedExtensions: () => [] as string[],
                        getExtension: () => null,
                    };
                    return Object.assign(() => ctx, ctx);
                })();
                try {
                    const glResolve = require.resolve('gl', { paths: [path.join(engineRoot, '..', '..')] });
                    (require('module') as any)._cache[glResolve] = {
                        id: 'gl',
                        filename: glResolve,
                        loaded: true,
                        exports: glStub,
                    };
                } catch {
                    // gl 不存在时无需 stub
                }
            }

            if (!(globalThis as any).nodeEnv) {
                const writablePath = process.env.CC_WRITABLE_PATH || path.join(engineRoot, '..', 'dist', 'writable');
                const nodeEnv: Record<string, any> = {
                    enginePath: engineRoot,
                    require,
                    userDataPath: writablePath,
                    process,
                    systemLanguage: Intl.DateTimeFormat().resolvedOptions().locale,
                };
                const optionalDeps: [string, string][] = [
                    ['sharp', 'sharp'],
                    ['xhr2', 'xhr2'],
                    ['socket.io-client', 'socket.io-client'],
                    ['node-localstorage', 'node-localstorage'],
                ];
                for (const [key, mod] of optionalDeps) {
                    try {
                        nodeEnv[key] = require(mod);
                    } catch {
                        // 可选依赖缺失时忽略
                    }
                }
                const LocalStorage = nodeEnv['node-localstorage'];
                if (LocalStorage && typeof LocalStorage.LocalStorage === 'function') {
                    nodeEnv.localStorage = new LocalStorage.LocalStorage(path.join(writablePath, 'node.localStorage'));
                }
                try {
                    nodeEnv.WebSocket = require('ws');
                    nodeEnv.fetch = globalThis.fetch;
                    nodeEnv.Headers = globalThis.Headers;
                    nodeEnv.Request = globalThis.Request;
                    nodeEnv.Response = globalThis.Response;
                } catch {
                    // 可选
                }
                (globalThis as any).nodeEnv = nodeEnv;
            }

            try {
                require(path.join(engineRoot, 'bin/.editor/web-adapter.js'));
            } catch {
                // web-adapter 缺失时引擎核心仍可加载
            }

            const { EngineLoader } = require(path.join(engineRoot, '..', '..', 'node_modules', 'cc', 'loader.js'));
            if (!EngineLoader.patched) {
                await EngineLoader.init(engineDevPath, [
                    'cc/editor/offline-mappings',
                    'cc/editor/populate-internal-constants',
                ]);
            }
        } catch (error) {
            // 初始化失败不阻塞进程，effect-compiler 会在需要时再次报错
            console.error('[effect-compile-process] failed to init engine environment:', error);
        }
    }

    return require('../../effect-compiler');
}

// Do not leave an orphan compiler process behind when the asset-db process exits.
process.on('disconnect', () => process.exit(0));

// Keep the compiler configuration in the child process. Importing the compiler
// in the asset-db process would load the parser and shader toolchain there too.
const compilerReady: Promise<any> = loadEffectCompiler().then((compiler) => {
    const { options } = compiler;

    options.throwOnWarning = true;
    options.skipParserTest = true;
    options.getAlternativeChunkPaths = (p: string) => {
        return [relative(state.chunkRoot, resolve(state.sourceDirectory, p)).replace(/\\/g, '/')];
    };
    options.chunkSearchFn = (names: string[]) => {
        for (const target of state.chunkTargets) {
            for (const name of names) {
                const file = resolve(target, 'chunks', `${name}.chunk`);
                if (!pathExistsSync(file)) {
                    continue;
                }
                return {
                    name,
                    content: readFileUtf8Sync(file),
                };
            }
        }

        return { name: undefined, content: undefined };
    };

    return compiler;
});

function send(message: IEffectCompileResult | IEffectCompileError): void {
    if (process.send) {
        process.send(message);
    }
}

process.on('message', (message: IEffectCompileRequest | IEffectAddChunkRequest) => {
    void compilerReady.then(async (compiler) => {
        try {
            if (message.type === 'add-chunk') {
                compiler.addChunk(message.name, message.content);
                send({ type: 'result', id: message.id, value: undefined });
                return;
            }

            state.chunkRoot = message.chunkRoot;
            state.sourceDirectory = message.sourceDirectory;
            state.chunkTargets = message.chunkTargets;
            send({
                type: 'result',
                id: message.id,
                value: compiler.buildEffect(message.name, message.content),
            });
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            send({ type: 'error', id: message.id, message: err.message, stack: err.stack });
        }
    });
});
