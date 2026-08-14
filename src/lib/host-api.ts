/**
 * Runtime API entry used by PinK.
 *
 * Keep all APIs in one CommonJS bundle. Bundling each API independently would
 * duplicate shared stateful modules (project, asset DB, configuration, etc.)
 * and could initialize the same singleton more than once in one process.
 */
export * as Assets from './assets/assets';
export * as Base from './base/base';
export * as Builder from './builder/builder';
export * as Configuration from './configuration/configuration';
export * as Engine from './engine/engine';
export * as Mcp from './mcp/mcp';
export * as Project from './project/project';
export * as Scene from './scene/scene';
export * as Server from './server/server';
export * as Scripting from './scripting/scripting';
export * as i18n from '../i18n';
