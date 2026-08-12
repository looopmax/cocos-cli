import { pathExistsSync } from '../../../../../filesystem';
import { BuilderAssetCache } from '../../manager/asset';
import { InternalBuildResult } from '../../manager/build-result';

import { readJSONSync } from '../../../../../filesystem';
import { dirname, join } from 'path';
import fg from 'fast-glob';
import { IBuilder, IInternalBuildOptions } from '../../../../@types/protected';

export async function handle(this: IBuilder, options: IInternalBuildOptions, result: InternalBuildResult, cache: BuilderAssetCache) {
    let settingsPath = result.paths.settings;
    if (!pathExistsSync(settingsPath)) {
        const settingsPaths = await fg('settings*.json', { cwd: dirname(result.paths.settings), absolute: true });
        settingsPath = settingsPaths[0];
        if (!settingsPath || !pathExistsSync(settingsPath)) {
            console.error(`Can not find cache settings failed in ${dirname(result.paths.settings)} when build ${options.platform}.`);
            return;
        }
    }
    result.paths.settings = settingsPath;
    result.settings = readJSONSync(settingsPath);
}
