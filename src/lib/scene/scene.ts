import { init as sceneInit, Scene } from '../../core/scene';
import { GlobalPaths } from '../../global';
import { Rpc } from '../../core/scene/main-process/rpc';
import type {
    ISceneCommandProvider,
    SceneCommandProviderRegistration,
} from '../../core/scene/main-process/rpc';
import type { AnimationGraphTarget } from '../../core/assets/@types/public';

export type {
    ISceneCommandProvider,
    SceneCommandProviderRegistration,
    SceneCommandRequestOptions,
} from '../../core/scene/main-process/rpc';
export { WorkerSceneCommandProvider } from '../../core/scene/main-process/rpc';

/**
 * Initialize the scene module.
 * Registers the scene middleware and initializes scene config.
 */
export async function init(): Promise<void> {
    await sceneInit();
}

/**
 * Start the scene worker process.
 *
 * @param projectPath Path to the project directory
 */
export async function startupWorker(projectPath: string): Promise<void> {
    const { sceneWorker } = await import('../../core/scene/main-process/scene-worker');
    await sceneWorker.start(GlobalPaths.enginePath, projectPath);
}

/** Installs a Scene command provider and returns an ownership-bound registration. */
export function setCommandProvider(
    provider: ISceneCommandProvider,
): SceneCommandProviderRegistration {
    return Rpc.setCommandProvider(provider);
}

/** Clears and disposes the active Scene command provider. */
export function resetCommandProvider(): void {
    Rpc.resetCommandProvider();
}

// ==================== Animation Graph Motion Preview ====================
// 将 scene-process PreviewService 的 AnimationGraph Motion 门面经场景进程 RPC 暴露给 PinK。
// 方法名与 IAnimationGraphMotionPreviewService 一一对应，供主进程 cocosHostScene 通道透传调用。

/** 显示指定 Motion 的预览（clip 或 blend 树）。@param uuidOrUrlOrPath 动画图资源标识。@param target 图内目标 Motion 的唯一地址。@returns 是否已成功显示预览。 */
export async function showAnimationGraphMotion(uuidOrUrlOrPath: string, target: AnimationGraphTarget): Promise<boolean> {
    return Scene.Preview.showAnimationGraphMotion(uuidOrUrlOrPath, target);
}

/** 隐藏当前 Motion 预览。 */
export function hideAnimationGraphMotion(): void {
    Scene.Preview.hideAnimationGraphMotion();
}

/** 为 Motion 预览设置展示模型资源。 @param uuid 模型资源 UUID。 */
export async function setAnimationGraphMotionModel(uuid: string): Promise<void> {
    return Scene.Preview.setAnimationGraphMotionModel(uuid);
}

/** 设置 Motion 预览的采样时间。 @param time 时间（秒）。 */
export function setAnimationGraphMotionTime(time: number): void {
    Scene.Preview.setAnimationGraphMotionTime(time);
}

/** 播放 Motion 预览。 */
export function playAnimationGraphMotion(): void {
    Scene.Preview.playAnimationGraphMotion();
}

/** 暂停 Motion 预览。 */
export function pauseAnimationGraphMotion(): void {
    Scene.Preview.pauseAnimationGraphMotion();
}

/** 停止 Motion 预览。 */
export function stopAnimationGraphMotion(): void {
    Scene.Preview.stopAnimationGraphMotion();
}

/** 设置 Motion 预览使用的变量值。 @param name 变量名。 @param value 变量值。 */
export function setAnimationGraphMotionVariable(name: string, value: number): void {
    Scene.Preview.setAnimationGraphMotionVariable(name, value);
}

/** 查询当前是否有活跃的 Motion 预览。 @returns 存在返回 true。 */
export async function isAnimationGraphMotionActive(): Promise<boolean> {
    return Scene.Preview.isAnimationGraphMotionActive();
}

/** 查询当前 Motion 预览的渲染图像帧。 @param info 图像尺寸。 @returns 图像帧数据。 */
export function queryAnimationGraphMotionImage(info: { width: number; height: number }): Promise<unknown> {
    return Scene.Preview.queryAnimationGraphMotionImage(info);
}
