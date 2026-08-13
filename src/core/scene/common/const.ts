/**
 * 场景进程初始化完成后的标记
 */
export const SceneReadyChannel = 'scene-worker:ready';

/**
 * Scene 子进程完成预热、等待项目启动参数时的标记。
 */
export const SceneWarmupReadyChannel = 'scene-worker:warmup-ready';

/**
 * 主进程要求 Scene 子进程使用项目参数完成真正启动的消息类型。
 */
export const SceneStartChannel = 'scene-worker:start';

/**
 * 场景进程标记
 */
export const SceneProcessEventTag = 'scene-worker-event';
