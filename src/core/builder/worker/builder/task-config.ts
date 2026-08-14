import { IBuildTask, IPluginHookName } from '../../@types/protected';

type TaskType = 'dataTasks' | 'settingTasks' | 'buildTasks' | 'md5Tasks' | 'postprocessTasks' | string;

/**
 * 任务模块静态注册表。
 *
 * 构建产物可能被 esbuild 打包成单文件 bundle，动态 `require(\`./tasks/${name}\`)`
 * 在 bundle 中无法解析模块路径，因此改为静态 import + 映射表，同时保留
 * 通过名称字符串访问的原有 API。
 */
const taskModuleMap: Record<string, () => IBuildTask> = {
    'data-task/asset': () => require('./tasks/data-task/asset'),
    'data-task/script': () => require('./tasks/data-task/script'),
    'build-task/script': () => require('./tasks/build-task/script'),
    'build-task/asset': () => require('./tasks/build-task/asset'),
    'postprocess-task/suffix': () => require('./tasks/postprocess-task/suffix'),
    'setting-task/asset': () => require('./tasks/setting-task/asset'),
    'setting-task/script': () => require('./tasks/setting-task/script'),
    'setting-task/options': () => require('./tasks/setting-task/options'),
    'postprocess-task/template': () => require('./tasks/postprocess-task/template'),
};

export class TaskManager {

    private static readonly tasks: Record<TaskType, string[]> = {
        dataTasks: [
            'data-task/asset',
            'data-task/script',
        ],
        // 注意先后顺序，不可随意调整，具体参考XXX（TODO）
        buildTasks: [
            // 资源处理，先脚本，后资源，资源包含 Bundle
            'build-task/script',
            'build-task/asset',
        ],
        md5Tasks: [
            // 项目处理
            'postprocess-task/suffix', // TODO 需要允许用户在 md5 注入之前修改内容
        ],
        settingTasks: [
            'setting-task/asset',
            'setting-task/script',
            'setting-task/options',
        ],
        postprocessTasks: [
            'postprocess-task/template',
        ],
    };

    static readonly pluginTasks: Record<IPluginHookName, IPluginHookName> = {
        onBeforeBuild: 'onBeforeBuild',
        onBeforeInit: 'onBeforeInit',
        onAfterInit: 'onAfterInit',
        onBeforeBuildAssets: 'onBeforeBuildAssets',
        onAfterBuildAssets: 'onAfterBuildAssets',
        onBeforeCompressSettings: 'onBeforeCompressSettings',
        onAfterCompressSettings: 'onAfterCompressSettings',
        onAfterBuild: 'onAfterBuild',
        onBeforeCopyBuildTemplate: 'onBeforeCopyBuildTemplate',
        onAfterCopyBuildTemplate: 'onAfterCopyBuildTemplate',
        onError: 'onError',
    };

    private static buildTaskMap: Record<TaskType, IBuildTask[]> = {
        dataTasks: [],
        settingTasks: [],
        buildTasks: [],
        md5Tasks: [],
        postprocessTasks: [],
    };

    activeTasks: Set<TaskType> = new Set();

    get taskWeight() {
        return 1 / this.activeTasks.size;
    }

    // 获取某一类资源任务
    public static getBuildTask(type: TaskType) {
        if (!this.buildTaskMap[type]) {
            return this.buildTaskMap[type];
        }
        return this.buildTaskMap[type] = TaskManager.tasks[type].map((name) => taskModuleMap[name]());
    }

    public static getTaskHandleFromNames(taskNames: string[]) {
        return taskNames.map((name) => {
            const load = taskModuleMap[name];
            if (load) {
                return load();
            }
            // 未知任务（插件自定义）回退到动态 require，此时散文件模式下可用
            return require(`./tasks/${name}`);
        });
    }

    public static getCustomTaskName(name: string) {
        return 'custom-task' + name;
    }

    public activeTask(type: TaskType) {
        this.activeTasks.add(type);
        return TaskManager.getBuildTask(type);
    }

    public activeCustomTask(name: string, taskNames: string[]) {
        const type = TaskManager.getCustomTaskName(name);
        // 自定义任务如果不可以复用缓存
        delete TaskManager.tasks[type];
        this.activeTasks.add(type);
        return TaskManager.buildTaskMap[type] = TaskManager.getTaskHandleFromNames(taskNames);
    }

}
