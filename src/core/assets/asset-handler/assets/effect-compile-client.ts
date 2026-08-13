import { ChildProcess, fork } from 'child_process';
import { join } from 'path';
import { Engine } from '../../../engine';
import type {
    IEffectAddChunkRequest,
    IEffectCompileError,
    IEffectCompileRequest,
    IEffectCompileResult,
} from './effect-compile-process';

interface IEffectCompilePendingRequest {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
}

/**
 * Owns the long-lived effect compiler process and serializes only the state
 * needed by the compiler over IPC. Keeping this client separate also lets the
 * effect-header handler register chunks without importing the compiler into
 * the asset-db process.
 */
class EffectCompileProcessClient {
    private child: ChildProcess | undefined;
    private requestId = 0;
    private readonly pending = new Map<number, IEffectCompilePendingRequest>();

    private ensureChild(): ChildProcess {
        if (this.child && this.child.connected) {
            return this.child;
        }

        const isTsNode = !!(process as any)[Symbol.for('ts-node.register.instance')]
            || !!process.env.TS_NODE_DEV;
        const workerExtension = __filename.endsWith('.ts') ? 'ts' : 'js';
        const workerPath = join(__dirname, `effect-compile-process.${workerExtension}`);
        const execArgv = process.execArgv.filter((arg) => !arg.startsWith('--inspect'));
        if (workerExtension === 'ts' && !isTsNode) {
            execArgv.push('-r', 'ts-node/register');
        }

        // 将引擎 dev 路径传给子进程，供其初始化 EngineLoader 以解析 cc/editor/* 引擎模块
        let engineRoot = '';
        let engineDevPath = '';
        try {
            const info = Engine.getInfo() as any;
            engineRoot = info?.typescript?.path ?? '';
            engineDevPath = engineRoot ? join(engineRoot, 'bin', '.cache', 'dev-cli') : '';
        } catch {
            // 引擎尚未初始化时保持为空，子进程跳过引擎初始化
        }

        const child = fork(workerPath, [], {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            execArgv,
            env: {
                ...process.env,
                ...(engineRoot ? { CC_ENGINE_ROOT: engineRoot } : {}),
                ...(engineDevPath ? { CC_ENGINE_DEV: engineDevPath } : {}),
            },
        });
        const rejectPending = (error: Error) => {
            for (const request of this.pending.values()) {
                request.reject(error);
            }
            this.pending.clear();
        };

        child.on('message', (message: IEffectCompileResult | IEffectCompileError) => {
            const request = this.pending.get(message.id);
            if (!request) {
                return;
            }
            this.pending.delete(message.id);
            if (message.type === 'error') {
                request.reject(Object.assign(new Error(message.message), { stack: message.stack }));
            } else {
                request.resolve(message.value);
            }
        });
        child.on('error', (error) => {
            if (this.child === child) {
                this.child = undefined;
            }
            rejectPending(error);
        });
        child.on('exit', (code, signal) => {
            if (this.child === child) {
                this.child = undefined;
            }
            if (this.pending.size) {
                rejectPending(new Error(`Effect compile process exited with code ${code ?? signal ?? 'unknown'}`));
            }
        });

        this.child = child;
        return child;
    }

    request<T>(message: Omit<IEffectCompileRequest, 'id'> | Omit<IEffectAddChunkRequest, 'id'>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let child: ChildProcess;
            try {
                child = this.ensureChild();
            } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }

            const id = ++this.requestId;
            this.pending.set(id, { resolve, reject });
            try {
                child.send({ ...message, id }, (error) => {
                    if (error) {
                        this.pending.delete(id);
                        reject(error);
                    }
                });
            } catch (error) {
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
}

export const effectCompileProcess = new EffectCompileProcessClient();
