import type {
  RegisteredTool,
  ToolContext,
  ToolDefinition,
} from './types.js';
import { withTimeout } from './async-utils.js';

export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
export const DEFAULT_TOOL_MAX_RESULT_CHARS = 8000;

export interface ToolRuntimeOptions {
  /** 单次工具执行超时，<=0 表示不限制 */
  timeoutMs?: number;
  /** 工具结果最大字符数，超出截断 */
  maxResultChars?: number;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return (
        typeof value === 'object' && value !== null && !Array.isArray(value)
      );
    default:
      return true; // 未知类型不拦截，避免误伤自定义 schema
  }
}

/**
 * 轻量 JSON Schema 校验：只处理模型工具最常用的 required / type / enum。
 * 不引入 ajv，避免给纯编排包增加运行时依赖。
 */
export function validateToolArgs(
  definition: ToolDefinition,
  args: Record<string, unknown>,
): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return '工具参数必须是对象';
  }

  const parameters = definition.function.parameters as {
    required?: unknown;
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
  };

  if (!parameters || typeof parameters !== 'object') return null;

  if (Array.isArray(parameters.required)) {
    for (const key of parameters.required) {
      if (typeof key !== 'string') continue;
      if (args[key] === undefined || args[key] === null) {
        return `缺少必填参数 ${key}`;
      }
    }
  }

  if (parameters.properties && typeof parameters.properties === 'object') {
    for (const [key, schema] of Object.entries(parameters.properties)) {
      const value = args[key];
      if (value === undefined || value === null || !schema) continue;

      if (schema.type && !matchesType(value, schema.type)) {
        return `参数 ${key} 应为 ${schema.type}`;
      }
      if (
        Array.isArray(schema.enum) &&
        schema.enum.length > 0 &&
        !schema.enum.includes(value)
      ) {
        return `参数 ${key} 必须是 ${schema.enum.join(' / ')} 之一`;
      }
    }
  }

  return null;
}

function toResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined || result === null) return '';
  try {
    const json = JSON.stringify(result);
    if (json !== undefined) return json;
  } catch {
    // 循环引用 / BigInt 等无法序列化的情况，落到下面的兜底
  }
  return Object.prototype.toString.call(result);
}

function capResult(text: string, maxResultChars: number): string {
  if (!maxResultChars || maxResultChars <= 0) return text;
  if (text.length <= maxResultChars) return text;
  return (
    text.slice(0, maxResultChars) +
    `\n…（工具结果已截断，原长 ${text.length} 字符）`
  );
}

/**
 * 工具运行时：编排器与具体工具之间的策略层。
 *
 * 负责参数校验、超时、取消、异常归一化、结果裁剪；
 * 编排器只关心“执行一个已注册工具并拿到字符串”。
 */
export class ToolRuntime {
  private readonly timeoutMs: number;
  private readonly maxResultChars: number;

  constructor(options: ToolRuntimeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.maxResultChars =
      options.maxResultChars ?? DEFAULT_TOOL_MAX_RESULT_CHARS;
  }

  async execute(
    tool: RegisteredTool,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<string> {
    const name = tool.definition.function.name;
    if (context.signal?.aborted) return `工具 ${name} 已取消`;
    const invalid = validateToolArgs(tool.definition, args);
    if (invalid) return `工具参数错误（${name}）：${invalid}`;

    try {
      const result = await withTimeout(
        Promise.resolve().then(() => tool.handler(args, context)),
        this.timeoutMs,
        context.signal,
        `工具 ${name} 执行超时（${this.timeoutMs}ms）`,
      );
      return capResult(toResultText(result), this.maxResultChars);
    } catch (error: any) {
      if (context.signal?.aborted || error?.name === 'AbortError') {
        return `工具 ${name} 已取消`;
      }
      if (error?.name === 'TimeoutError') {
        return `工具 ${name} 执行超时（${this.timeoutMs}ms），已跳过`;
      }
      return `工具执行出错（${name}）：${error?.message ?? String(error)}`;
    }
  }
}
