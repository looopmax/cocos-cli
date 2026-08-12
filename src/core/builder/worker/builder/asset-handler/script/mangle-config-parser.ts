import * as fs from 'fs-extra';
import { readJSONSync } from '../../../../../filesystem';

export interface MangleConfig {
    mangleProtected?: boolean;
    mangleList?: string[];
    dontMangleList?: string[];
    extends?: string;
}

interface ConfigFile {
    [key: string]: MangleConfig;
}

function mergeConfigs(baseConfig: MangleConfig, extendConfig: MangleConfig): MangleConfig {
    return {
        mangleProtected: extendConfig.mangleProtected !== undefined ? extendConfig.mangleProtected : baseConfig.mangleProtected,
        mangleList: [...(baseConfig.mangleList || []), ...(extendConfig.mangleList || [])],
        dontMangleList: [...(baseConfig.dontMangleList || []), ...(extendConfig.dontMangleList || [])],
        extends: baseConfig.extends,
    };
}

export function parseMangleConfig(filePath: string, platform: string): MangleConfig | undefined {
    if (!fs.existsSync(filePath)) {
        return undefined;
    }
    const configFile = readJSONSync<ConfigFile>(filePath);

    if (!configFile[platform]) {
        throw new Error(`Platform ${platform} not found in the configuration file.`);
    }

    let config = configFile[platform];
    while (config.extends) {
        const baseConfig = configFile[config.extends];
        if (!baseConfig) {
            throw new Error(`Base configuration ${config.extends} not found.`);
        }
        config = mergeConfigs(baseConfig, config);
    }

    return config;
}
