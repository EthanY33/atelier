/**
 * Runtime dependencies live in plugins/atelier/node_modules (the plugin is
 * its own npm project). Tests load them from there too, so a test and the
 * skill under test share one copy of sharp/libvips instead of two.
 */
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../plugins/atelier/package.json', import.meta.url));

export const sharp = require('sharp');
const ajv2020 = require('ajv/dist/2020.js');
export const Ajv2020 = ajv2020.default ?? ajv2020;
const formats = require('ajv-formats');
export const addFormats = formats.default ?? formats;
export const pluginRequire = require;
