import { join, resolve } from 'path';
import Module from 'module';

export interface IEngineLoader {
    import(id: string): Promise<unknown>;
}

type ModuleParent = {
    filename?: string;
};

type ResolveFilename = (this: typeof Module, request: string, parent?: ModuleParent, isMain?: boolean, options?: unknown) => string;
type LoadModule = (this: typeof Module, request: string, parent?: ModuleParent, isMain?: boolean) => unknown;

const ModuleInternal = Module as typeof Module & {
    _resolveFilename: ResolveFilename;
    _load: LoadModule;
};

export class EngineLoader {
    static isEngineModule(request: string): boolean {
        if (request === 'cc') {
            return true;
        }
        if (request.startsWith('cc/preload')) {
            return false;
        }
        return request.startsWith('cc/') || request.startsWith('cce:/internal/');
    }

    /**
     * Engine modules are addressed by their virtual module id, so a null-prototype
     * object avoids prototype checks and also keeps module ids isolated from object keys.
     */
    private static engineModules: Record<string, any> = Object.create(null) as Record<string, any>;

    /** Deduplicates concurrent dynamic imports of the same engine module. */
    private static modulePromises = new Map<string, Promise<unknown>>();

    /** Prevents wrapping Node's module loader more than once in a process. */
    private static patched = false;

    /** Shares an in-progress initialization between concurrent callers. */
    private static initPromise: Promise<void> | undefined;

    /**
     * Node's resolver checks several candidate paths for every uncached request.
     * Keep this bounded and only cache normal requests without custom resolve options.
     */
    private static readonly resolveCacheLimit = 4096;
    private static resolveCache = new Map<string, string>();

    public static getEngineModuleById(id: string): any {
        return EngineLoader.engineModules[id];
    }

    private static hasEngineModule(id: string): boolean {
        return Object.prototype.hasOwnProperty.call(EngineLoader.engineModules, id);
    }

    private static loader: IEngineLoader | undefined;

    private static createEngineLoader(engineDevPath: string): IEngineLoader {
        const loaderModule = require(resolve(join(engineDevPath, 'editor'), 'loader')) as {
            default: IEngineLoader;
        };

        return loaderModule.default;
    }

    public static init(engineDevPath: string, modules: string[]): Promise<void> {
        // EngineLoader is process-global. Reinitializing it would stack multiple
        // Module._load/_resolveFilename wrappers and make every require slower.
        if (this.patched) {
            return Promise.resolve();
        }
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = (async () => {
            this.loader = this.createEngineLoader(engineDevPath);
            await this.requiredModules(modules);

            const vendorResolveFilename = ModuleInternal._resolveFilename;
            const vendorLoad = ModuleInternal._load;

            this.resolveCache.clear();

            ModuleInternal._resolveFilename = function (this: typeof Module, request: string, parent?: ModuleParent, isMain?: boolean, options?: unknown) {
                if (EngineLoader.isEngineModule(request)) {
                    return request;
                }

                // Custom resolve options can change the result independently of the
                // parent filename, so leave those calls on Node's resolver.
                const cacheKey = options === undefined
                    ? `${parent?.filename ?? ''}\0${isMain ? '1' : '0'}\0${request}`
                    : undefined;
                if (cacheKey !== undefined) {
                    const cached = EngineLoader.resolveCache.get(cacheKey);
                    if (cached !== undefined) {
                        return cached;
                    }
                }

                const resolved = Reflect.apply(vendorResolveFilename, this, arguments as any);
                if (cacheKey !== undefined) {
                    if (EngineLoader.resolveCache.size >= EngineLoader.resolveCacheLimit) {
                        const oldestKey = EngineLoader.resolveCache.keys().next().value as string | undefined;
                        if (oldestKey !== undefined) {
                            EngineLoader.resolveCache.delete(oldestKey);
                        }
                    }
                    EngineLoader.resolveCache.set(cacheKey, resolved);
                }
                return resolved;
            };

            ModuleInternal._load = function (this: typeof Module, request: string, parent?: ModuleParent, isMain?: boolean) {
                if (EngineLoader.isEngineModule(request)) {
                    if (EngineLoader.hasEngineModule(request)) {
                        return EngineLoader.getEngineModuleById(request);
                    }
                    throw new Error(
                        `Can not load engine module: ${request}. Valid engine modules are: ${Object.keys(EngineLoader.engineModules).join(',')}`,
                    );
                }

                return Reflect.apply(vendorLoad, this, arguments as any);
            };

            this.patched = true;
        })().finally(() => {
            this.initPromise = undefined;
        });

        return this.initPromise;
    }

    public static async requiredModules(modules: string[]) {
        if (!this.loader) {
            throw new Error(`Failed to load engine module ${modules.join(',')}. ` + 'Loader has not been initialized. engineLoader.init.');
        }

        for (const module of new Set(modules)) {
            try {
                EngineLoader.engineModules[module] = await this.importModule(module);
            } catch (e) {
                console.error(`Failed to load engine module: ${module}  e: ${e}`);
            }
        }
    }

    public static async importModule(module: string) {
        if (!this.loader) {
            throw new Error(`Failed to load engine module ${module}. ` + 'Loader has not been initialized. engineLoader.init.');
        }

        const cachedPromise = this.modulePromises.get(module);
        if (cachedPromise) {
            return await cachedPromise;
        }

        const promise = this.loader.import(module);
        this.modulePromises.set(module, promise);
        promise.catch(() => {
            // Failed imports must be retryable, while successful imports stay
            // deduplicated for the lifetime of this process.
            if (this.modulePromises.get(module) === promise) {
                this.modulePromises.delete(module);
            }
        });
        return await promise;
    }
}
