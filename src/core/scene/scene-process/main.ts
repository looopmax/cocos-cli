import { SceneReadyChannel, SceneStartChannel, SceneWarmupReadyChannel } from '../common';
import { Rpc } from './rpc';
import { parseCommandLineArgs, resolveSceneAssetBase } from './utils';
import { Engine } from '../../engine';
import { join } from 'path';
import { serviceManager } from './service/service-manager';

interface ISceneStartMessage {
    type: typeof SceneStartChannel;
    projectPath: string;
    serverURL?: string;
}

function isSceneStartMessage(message: unknown): message is ISceneStartMessage {
    return !!message
        && typeof message === 'object'
        && (message as ISceneStartMessage).type === SceneStartChannel
        && typeof (message as ISceneStartMessage).projectPath === 'string';
}

function waitForStartMessage(): Promise<ISceneStartMessage> {
    return new Promise((resolve) => {
        const onMessage = (message: unknown) => {
            if (!isSceneStartMessage(message)) {
                return;
            }
            process.off('message', onMessage);
            resolve(message);
        };
        process.on('message', onMessage);
    });
}

async function prewarm(enginePath: string): Promise<void> {
    await Engine.init(enginePath);
}

async function start(enginePath: string, projectPath: string, serverURL?: string): Promise<void> {
    serviceManager.initialize(serverURL ?? '');

    const libraryPath = join(projectPath, 'library');
    const assetBase = resolveSceneAssetBase(serverURL, libraryPath);
    await Engine.initEngine({
        serverURL,
        importBase: assetBase,
        nativeBase: assetBase,
        writablePath: join(projectPath, 'temp'),
        enableCustomPipeline: false,
    }, async () => {
        // 导入 service，处理装饰器，捕获开发的 api
        await import('./service');
        console.log('[Scene] import service');
        await Rpc.startup();
        console.log('[Scene] startup Rpc');

        const { Service } = await import('./service/core/decorator');
        (globalThis.cce as any) = {
            Script: Service.Script
        };
    }, async () => {
        await cc.game.run();
        // 初始化 engine 服务
        const { Service } = await import('./service/core/decorator');
        await Service.Engine.init();
        await serviceManager.initAllServices();
    });

    console.log('[Scene] initEngine success');
}

async function startup() {
    // 监听进程退出事件
    process.on('message', (msg) => {
        if (msg === 'scene-process:exit') {
            Rpc.dispose();
            process.disconnect?.(); // 关闭 IPC
            process.exit(0);// 退出进程
        }
    });

    // 父进程死亡时 IPC 通道断开，立即退出避免被 launchd 收养成为孤儿进程
    process.on('disconnect', () => {
        console.log('[Scene] Parent disconnected, exiting');
        process.exit(0);
    });

    console.log(`[Scene] startup worker pid: ${process.pid}`);

    console.log(`[Scene] parse args ${process.argv}`);
    const { enginePath } = parseCommandLineArgs(process.argv);
    if (!enginePath) {
        throw new Error('enginePath is not set');
    }

    // 预热阶段只初始化与项目无关的 Engine 元数据，避免提前读取 project。
    await prewarm(enginePath);
    process.send?.(SceneWarmupReadyChannel);
    console.log('[Scene] worker warmed up, waiting for project');

    // 真正启动阶段由父进程通过 IPC 传入 project 和 server URL。
    const { projectPath, serverURL } = await waitForStartMessage();
    await start(enginePath, projectPath, serverURL);

    // 发送消息给父进程，表示项目场景服务已经完成初始化。
    process.send?.(SceneReadyChannel);
    console.log(`[Scene] startup worker success, cocos version: ${cc.ENGINE_VERSION}`);
}

startup().catch(err => {
    console.error('[Scene] Startup fatal error:', err);
    process.exit(1);
});
