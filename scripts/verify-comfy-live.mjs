import { tsImport } from 'tsx/esm/api';
const { checkComfyConfiguration } = await tsImport('./verify-comfy-live.ts', import.meta.url);
console.log(JSON.stringify(checkComfyConfiguration(process.argv.slice(2))));
