import { Ajv } from 'ajv';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { isDeepStrictEqual } from 'node:util';
import { classifyNativeRequest, nativeApprovalDecisions } from '../shared/native-requests.js';
import type { NativeServerRequest } from '../shared/types.js';

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const stringList = { type: ['array', 'null'], items: { type: 'string' } };
const permissionProfile = ajv.compile({ type: 'object', additionalProperties: false, properties: {
  network: { type: ['object', 'null'], additionalProperties: false, properties: { enabled: { type: ['boolean', 'null'] } } },
  fileSystem: { type: ['object', 'null'], additionalProperties: false, properties: {
    read: stringList, write: stringList, globScanMaxDepth: { type: ['integer', 'null'], minimum: 1 },
    entries: { type: ['array', 'null'], items: { type: 'object', required: ['access', 'path'], additionalProperties: false, properties: {
      access: { enum: ['read', 'write', 'deny'] }, path: { type: 'object', required: ['type'], properties: { type: { enum: ['path', 'glob_pattern', 'special'] } } },
    } } },
  } },
} });
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireShape(value: unknown, keys: string[], required: string[]) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new Error('原生响应字段不正确。');
}
function subset(granted: unknown, requested: unknown): boolean {
  if (Array.isArray(granted)) return Array.isArray(requested) && granted.every(value => requested.some(entry => isDeepStrictEqual(value, entry)));
  if (object(granted)) return object(requested) && Object.keys(granted).every(key => Object.hasOwn(requested, key) && subset(granted[key], requested[key]));
  return isDeepStrictEqual(granted, requested);
}
export function validateNativeResponse(request: NativeServerRequest, result: unknown): void {
  const kind = classifyNativeRequest(request), p = request.params ?? {}, value = result as any;
  switch (kind) {
    case 'approval':
      requireShape(result, ['decision'], ['decision']);
      if (!nativeApprovalDecisions(request).some(decision => isDeepStrictEqual(decision, value.decision))) throw new Error('批准决定必须来自本次请求提供的选项。');
      return;
    case 'question': {
      requireShape(result, ['answers'], ['answers']);
      const ids = new Set((Array.isArray(p.questions) ? p.questions : []).map((q: any) => q.id));
      const valid = ajv.validate({ type: 'object', additionalProperties: { type: 'object', required: ['answers'], additionalProperties: false, properties: { answers: { type: 'array', items: { type: 'string' } } } } }, value.answers);
      if (!valid || Object.keys(value.answers).some(id => !ids.has(id))) throw new Error('答案必须关联本次请求的实际问题 ID。');
      return;
    }
    case 'permissions': {
      requireShape(result, ['permissions', 'scope', 'strictAutoReview'], ['permissions']);
      if (!permissionProfile(value.permissions) || !subset(value.permissions, p.permissions ?? {}) || !['turn', 'session'].includes(value.scope ?? 'turn') || (p.scope === 'turn' && value.scope === 'session') || (value.strictAutoReview != null && typeof value.strictAutoReview !== 'boolean')) throw new Error('授予的权限或范围超出了本次请求。');
      const fileSystem = value.permissions.fileSystem, entries = fileSystem?.entries ?? [];
      const grantsAccess = fileSystem?.read?.length || fileSystem?.write?.length || entries.some((entry: any) => entry.access !== 'deny');
      if (grantsAccess && (p.permissions?.fileSystem?.entries ?? []).some((entry: any) => entry.access === 'deny' && !entries.some((grant: any) => isDeepStrictEqual(entry, grant)))) throw new Error('权限回应不能移除请求中的拒绝规则。');
      return;
    }
    case 'elicitation-form': case 'elicitation-url':
      requireShape(result, ['action', 'content', '_meta'], ['action']);
      if (!['accept', 'decline', 'cancel'].includes(value.action)) throw new Error('插件响应动作不正确。');
      if (value.action !== 'accept' || kind === 'elicitation-url') {
        if (value.content != null) throw new Error('取消、拒绝或 URL 确认不能携带表单内容。');
      } else {
        if (!object(p.requestedSchema)) throw new Error('插件请求缺少表单 Schema。');
        const schema = structuredClone(p.requestedSchema);
        // RMCP typed form metadata serializes absent optional constraints as null.
        if (p.mode === 'form') {
          if (schema.required === null) delete schema.required;
          for (const field of Object.values(schema.properties ?? {})) if (object(field)) {
            for (const key of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'format', 'enum', 'oneOf']) if (field[key] === null) delete field[key];
          }
        }
        if (!new AjvJsonSchemaValidator().getValidator(schema)(value.content).valid) throw new Error('插件表单内容不符合请求 Schema。');
      }
      return;
    default: throw new Error('这个请求需要尚未接入的宿主能力，不能提交人工响应。');
  }
}
