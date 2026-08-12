import { readFileUtf8Sync } from '../filesystem';
import { join } from 'path';
import { existsSync, readdirSync } from 'fs';
import { AssetDBRegisterInfo } from './@types/private';
import { configurationManager, configurationRegistry, ConfigurationScope, IBaseConfiguration } from '../configuration';
import { MessageType } from '../configuration/script/interface';
import project from '../project';
import { Engine } from '../engine';
import { createImportMetadataNodes } from './metadata';
import { DEFAULT_CREATE_TEMPLATE_ROOT, resolveImportTemplateRoot } from './import-config-defaults';

export interface AssetDBConfig {
    restoreAssetDBFromCache: boolean;
    flagReimportCheck: boolean;
    globList?: string[];
    /**
     * 资源 userData 的默认值
     */
    userDataTemplate?: Record<string, any>;

    /**
     * 资源数据库信息列表
     */
    assetDBList: AssetDBRegisterInfo[];

    /**
     * 资源根目录，通常是项目目录
     */
    root: string;

    /**
     * 资源库导入后根目录，通常根据配置的 root 计算
     */
    libraryRoot: string;

    tempRoot: string;
    createTemplateRoot: string;

    sortingPlugin: string[];
}

class AssetConfig {
    /**
     * 环境共享的资源库配置
     */
    private _assetConfig: AssetDBConfig = {
        restoreAssetDBFromCache: false,
        flagReimportCheck: false,
        globList: [],
        assetDBList: [],
        root: '',
        libraryRoot: '',
        tempRoot: '',
        createTemplateRoot: '',
        sortingPlugin: [],
        // fbx.material.smart
    };

    private _init = false;
    private _watchingConfiguration = false;

    /**
     * 持有的可双向绑定的配置管理实例
     */
    private _configInstance!: IBaseConfiguration;
    get data() {
        if (!this._init) {
            throw new Error('AssetConfig not init');
        }
        return this._assetConfig;
    }

    async init() {
        if (this._init) {
            console.warn('AssetConfig already init');
            return;
        }
        this._configInstance = await configurationRegistry.register('import', {
            defaults: {
                restoreAssetDBFromCache: this._assetConfig.restoreAssetDBFromCache,
                globList: this._assetConfig.globList ?? [],
                createTemplateRoot: DEFAULT_CREATE_TEMPLATE_ROOT,
            },
            nodes: () => createImportMetadataNodes(),
        });
        if (!project.path) {
            throw new Error('Project not found');
        }
        this._assetConfig.root = project.path;
        const enginePath = Engine.getInfo().typescript.path;
        this._assetConfig.libraryRoot = this._assetConfig.libraryRoot || join(this._assetConfig.root, 'library');
        this._assetConfig.tempRoot = join(this._assetConfig.root, 'temp/asset-db');
        this.watchConfigurationChanges();
        await this.syncRuntimeConfigFromConfiguration();
        this._assetConfig.assetDBList = [{
            name: 'assets',
            target: join(this._assetConfig.root, 'assets'),
            readonly: false,
            visible: true,
            library: join(this._assetConfig.root, 'library'),
        }, {
            name: 'internal',
            target: join(enginePath, 'editor/assets'),
            readonly: true,
            visible: true,
            library: join(enginePath, 'editor/library'),
        }];

        // Scan project extensions for asset-db mount contributions and register their db:// domains
        const extensionsDir = join(this._assetConfig.root, 'extensions');
        if (existsSync(extensionsDir)) {
            try {
                const entries = readdirSync(extensionsDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    const extDir = join(extensionsDir, entry.name);
                    const pkgJsonPath = join(extDir, 'package.json');
                    if (!existsSync(pkgJsonPath)) continue;
                    try {
                        const pkgJson = JSON.parse(readFileUtf8Sync(pkgJsonPath));
                        const mount = pkgJson?.contributions?.['asset-db']?.mount;
                        if (!mount?.path) continue;
                        const mountTarget = join(extDir, mount.path);
                        if (!existsSync(mountTarget)) continue;
                        this._assetConfig.assetDBList.push({
                            name: pkgJson.name || entry.name,
                            target: mountTarget,
                            readonly: mount.readonly ?? true,
                            visible: mount.visible ?? false,
                            library: join(this._assetConfig.root, `library/${pkgJson.name || entry.name}`),
                        });
                    } catch {
                        // Skip extensions with invalid package.json
                    }
                }
            } catch {
                // Ignore errors scanning extensions directory
            }
        }

        this._init = true;
    }

    getProject<T>(path: string, scope?: ConfigurationScope): Promise<T> {
        return this._configInstance.get(path, scope);
    }

    setProject(path: string, value: any, scope?: ConfigurationScope) {
        return this._configInstance.set(path, value, scope);
    }

    setSortingPlugin(value: unknown) {
        this._assetConfig.sortingPlugin = Array.isArray(value)
            ? value.filter((item): item is string => typeof item === 'string')
            : [];
    }

    async syncSortingPluginFromConfiguration() {
        const scriptConfigInstance = configurationRegistry.getInstances().script;
        if (!scriptConfigInstance) {
            return;
        }

        const scriptConfig = await scriptConfigInstance.get<{ sortingPlugin?: unknown }>();
        this.setSortingPlugin(scriptConfig?.sortingPlugin);
    }

    private async syncRuntimeConfigFromConfiguration() {
        const importConfig = await this._configInstance.get<Partial<Pick<AssetDBConfig, 'restoreAssetDBFromCache' | 'globList' | 'createTemplateRoot'>>>();
        this._assetConfig.restoreAssetDBFromCache = importConfig.restoreAssetDBFromCache ?? false;
        this._assetConfig.globList = importConfig.globList ?? [];
        this._assetConfig.createTemplateRoot = resolveImportTemplateRoot(
            this._assetConfig.root,
            importConfig.createTemplateRoot ?? DEFAULT_CREATE_TEMPLATE_ROOT
        );
        await this.syncSortingPluginFromConfiguration();
    }

    private watchConfigurationChanges() {
        if (this._watchingConfiguration) {
            return;
        }
        this._watchingConfiguration = true;

        configurationRegistry.on(MessageType.Registry, (instance: IBaseConfiguration) => {
            if (instance.moduleName === 'script') {
                void this.syncSortingPluginFromConfiguration();
            }
        });

        configurationManager.on(MessageType.Update, (key: string) => {
            if (key === 'script.sortingPlugin' || key === 'script') {
                void this.syncSortingPluginFromConfiguration();
            }
        });

        configurationManager.on(MessageType.Remove, (key: string) => {
            if (key === 'script.sortingPlugin' || key === 'script') {
                this.setSortingPlugin([]);
            }
        });

        configurationManager.on(MessageType.Reload, () => {
            void this.syncRuntimeConfigFromConfiguration();
        });
    }
}

export default new AssetConfig();
