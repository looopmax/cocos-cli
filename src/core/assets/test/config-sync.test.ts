import { pathExistsSync } from '../../filesystem';
'use strict';

import { join } from 'path';
import { ensureDir, remove } from 'fs-extra';
import { outputJSONSync, readJSONSync } from '../../filesystem';
import { TestGlobalEnv } from '../../../tests/global-env';

interface IAssetConfigRuntime {
    configurationManager: typeof import('../../configuration').configurationManager;
    project: typeof import('../../project').default;
    Engine: typeof import('../../engine').Engine;
    initAssetDB: typeof import('../index').initAssetDB;
    assetConfig: typeof import('../asset-config').default;
    assetDBManager: typeof import('../manager/asset-db').default;
    assetHandlerManager: typeof import('../manager/asset-handler').default;
    scriptConfig: typeof import('../../scripting/shared/query-shared-settings').scriptConfig;
}

const configPath = join(TestGlobalEnv.projectRoot, 'settings', 'cocos.config.json');
const originalConfig = readJSONSync(configPath);
const legacyTemplateRoot = join(TestGlobalEnv.projectRoot, '.creator', 'asset-template');

function createImportConfig(customTemplateRoot: string) {
    return {
        globList: ['!**/*.tmp', '!**/*.bak'],
        restoreAssetDBFromCache: true,
        createTemplateRoot: customTemplateRoot,
        fbx: {
            material: {
                smart: true,
            },
        },
    };
}

function writeProjectImportConfig(importConfig: Record<string, unknown>) {
    const nextConfig = JSON.parse(JSON.stringify(originalConfig));
    nextConfig.import = importConfig;
    outputJSONSync(configPath, nextConfig, { spaces: 4 });
}

function writeProjectScriptConfig(scriptConfig: Record<string, unknown>) {
    const nextConfig = JSON.parse(JSON.stringify(originalConfig));
    nextConfig.script = {
        ...nextConfig.script,
        ...scriptConfig,
    };
    outputJSONSync(configPath, nextConfig, { spaces: 4 });
}

function waitForAsyncListeners(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

async function loadFreshRuntime(): Promise<IAssetConfigRuntime> {
    jest.resetModules();
    const { configurationManager } = require('../../configuration') as typeof import('../../configuration');
    const project = (require('../../project') as typeof import('../../project')).default;
    const { Engine } = require('../../engine') as typeof import('../../engine');
    const { initAssetDB } = require('../index') as typeof import('../index');
    const assetConfig = (require('../asset-config') as typeof import('../asset-config')).default;
    const assetDBManager = (require('../manager/asset-db') as typeof import('../manager/asset-db')).default;
    const assetHandlerManager = (require('../manager/asset-handler') as typeof import('../manager/asset-handler')).default;
    const { scriptConfig } = require('../../scripting/shared/query-shared-settings') as typeof import('../../scripting/shared/query-shared-settings');

    return {
        configurationManager,
        project,
        Engine,
        initAssetDB,
        assetConfig,
        assetDBManager,
        assetHandlerManager,
        scriptConfig,
    };
}

describe('asset import config sync', () => {
    afterEach(async () => {
        outputJSONSync(configPath, JSON.parse(JSON.stringify(originalConfig)), { spaces: 4 });
        await remove(legacyTemplateRoot);
        const creatorRoot = join(TestGlobalEnv.projectRoot, '.creator');
        if (pathExistsSync(creatorRoot)) {
            const entries = require('fs').readdirSync(creatorRoot);
            for (const entry of entries) {
                if (entry.startsWith('custom-template-root-')) {
                    await remove(join(creatorRoot, entry));
                }
            }
        }
    });

    it('should sync project import config into the runtime asset config and asset-db state', async () => {
        const customTemplateRoot = `.creator/custom-template-root-${Date.now()}`;
        writeProjectImportConfig(createImportConfig(customTemplateRoot));

        const runtime = await loadFreshRuntime();
        await runtime.configurationManager.initialize(TestGlobalEnv.projectRoot);
        await runtime.project.open(TestGlobalEnv.projectRoot);
        await runtime.Engine.init(TestGlobalEnv.engineRoot);
        await ensureDir(join(TestGlobalEnv.projectRoot, 'library'));
        await runtime.assetConfig.init();
        await runtime.assetDBManager.init();

        await expect(runtime.assetConfig.getProject<string[]>('globList')).resolves.toEqual(['!**/*.tmp', '!**/*.bak']);
        await expect(runtime.assetConfig.getProject<boolean>('restoreAssetDBFromCache')).resolves.toEqual(true);
        await expect(runtime.assetConfig.getProject<string>('createTemplateRoot')).resolves.toEqual(customTemplateRoot);
        await expect(runtime.assetConfig.getProject<boolean>('fbx.material.smart')).resolves.toEqual(true);

        expect(runtime.assetConfig.data.globList).toEqual(['!**/*.tmp', '!**/*.bak']);
        expect(runtime.assetConfig.data.restoreAssetDBFromCache).toBe(true);
        expect(runtime.assetConfig.data.createTemplateRoot).toBe(join(TestGlobalEnv.projectRoot, customTemplateRoot));
        expect((runtime.assetDBManager as any).constructor.useCache).toBe(true);
        expect(runtime.assetDBManager.assetDBInfo.assets.globList).toEqual(['!**/*.tmp', '!**/*.bak']);
    });

    it('should use the configured template root when preparing the TypeScript create menu', async () => {
        const customTemplateRoot = `.creator/custom-template-root-${Date.now()}`;
        writeProjectImportConfig(createImportConfig(customTemplateRoot));

        const runtime = await loadFreshRuntime();
        await runtime.configurationManager.initialize(TestGlobalEnv.projectRoot);
        await runtime.project.open(TestGlobalEnv.projectRoot);
        await runtime.Engine.init(TestGlobalEnv.engineRoot);
        await runtime.assetConfig.init();
        await runtime.assetDBManager.init();

        const configuredGuideFile = join(TestGlobalEnv.projectRoot, customTemplateRoot, 'typescript', 'Custom Script Template Help Documentation.url');
        const legacyGuideFile = join(legacyTemplateRoot, 'typescript', 'Custom Script Template Help Documentation.url');

        await runtime.assetHandlerManager.getCreateMenuByName('typescript');

        expect(pathExistsSync(configuredGuideFile)).toBe(true);
        expect(pathExistsSync(legacyGuideFile)).toBe(false);
    });

    it('should sync project script sortingPlugin after script config registers', async () => {
        const sortingPlugin = ['plugin-uuid-a', 'plugin-uuid-b'];
        writeProjectScriptConfig({ sortingPlugin });

        const runtime = await loadFreshRuntime();
        await runtime.configurationManager.initialize(TestGlobalEnv.projectRoot);
        await runtime.project.open(TestGlobalEnv.projectRoot);
        await runtime.Engine.init(TestGlobalEnv.engineRoot);
        await runtime.assetConfig.init();

        expect(runtime.assetConfig.data.sortingPlugin).toEqual([]);

        await runtime.scriptConfig.init();
        await waitForAsyncListeners();

        expect(runtime.assetConfig.data.sortingPlugin).toEqual(sortingPlugin);
    });

    it('should load script sortingPlugin when initializing asset-db without explicit scripting init', async () => {
        const sortingPlugin = ['plugin-uuid-a', 'plugin-uuid-b'];
        writeProjectScriptConfig({ sortingPlugin });

        const runtime = await loadFreshRuntime();
        await runtime.configurationManager.initialize(TestGlobalEnv.projectRoot);
        await runtime.project.open(TestGlobalEnv.projectRoot);
        await runtime.Engine.init(TestGlobalEnv.engineRoot);
        await ensureDir(join(TestGlobalEnv.projectRoot, 'library'));
        await runtime.initAssetDB();

        expect(runtime.assetConfig.data.sortingPlugin).toEqual(sortingPlugin);
    });

    it('should keep runtime sortingPlugin in sync when configuration changes', async () => {
        const runtime = await loadFreshRuntime();
        await runtime.configurationManager.initialize(TestGlobalEnv.projectRoot);
        await runtime.project.open(TestGlobalEnv.projectRoot);
        await runtime.Engine.init(TestGlobalEnv.engineRoot);
        await runtime.assetConfig.init();
        await runtime.scriptConfig.init();

        await runtime.configurationManager.set('script.sortingPlugin', ['plugin-uuid-c']);
        await waitForAsyncListeners();

        expect(runtime.assetConfig.data.sortingPlugin).toEqual(['plugin-uuid-c']);

        await runtime.scriptConfig.setProject('sortingPlugin', ['plugin-uuid-d']);
        await runtime.configurationManager.save(true);

        expect(runtime.assetConfig.data.sortingPlugin).toEqual(['plugin-uuid-d']);

        await runtime.configurationManager.remove('script.sortingPlugin');

        expect(runtime.assetConfig.data.sortingPlugin).toEqual([]);
    });
});
