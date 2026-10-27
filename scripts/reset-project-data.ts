import { resolve } from 'node:path';
import { readWorkflowDefinition, resetProjectData } from '../src/core/project-reset.js';

const [target, ...args] = process.argv.slice(2);
if (!target || args.some((arg, index) => !['--apply', '--from'].includes(arg) && args[index - 1] !== '--from')) throw new Error('Usage: node --import tsx scripts/reset-project-data.ts <project-root> [--from <existing-project-root>] --apply');
const from = args.indexOf('--from'), source = from >= 0 ? args[from + 1] : target;
if (!source) throw new Error('--from requires an existing project directory.');
const definition = readWorkflowDefinition(resolve(source));
if (!args.includes('--apply')) console.log(JSON.stringify({ target: resolve(target), nodes: definition.nodes.length, edges: definition.edges.length, action: 'Add --apply after stopping the target desktop to reset runtime data and retain this graph.' }, null, 2));
else console.log(JSON.stringify(resetProjectData(resolve(target), definition), null, 2));
