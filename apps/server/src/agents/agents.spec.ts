import { describe, expect, it, vi } from 'vitest';
import {
  AgentOrchestrator,
  loadModelCascadeConfig,
  SimpleLock,
} from '@repo/agent-orchestrator';
import { ModelClients } from '../agent/model-clients.js';
import { AgentRunner } from './runner.js';
import { getAgent, listAgents } from './registry.js';

function streamOf(chunks: any[]) {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

function mkRunner() {
  const zhipuCreate = vi.fn(async () => streamOf([]));
  const qwenCreate = vi.fn(async () => streamOf([]));
  const clients = new ModelClients(
    { chat: { completions: { create: qwenCreate } } } as never,
    { chat: { completions: { create: zhipuCreate } } } as never,
  );
  const orchestrator = new AgentOrchestrator({
    getClient: (provider) => clients.getClient(provider),
    modelConfig: loadModelCascadeConfig(),
    showRoutingThought: false,
    rateLimitRetries: 0,
    zhipuLock: new SimpleLock(),
  });
  return new AgentRunner(orchestrator);
}

const toolNames = (agentId: string) =>
  getAgent(agentId)!.tools.map((t) => t.definition.function.name);

describe('agent 注册', () => {
  it('editor 注册了文件工具集', () => {
    expect(toolNames('editor')).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'apply_patch',
      'delete_file',
      'move_file',
      'create_directory',
      'list_dir',
      'search_files',
      'glob',
      'run_terminal',
      'git_status',
      'git_diff',
    ]);
  });

  it('general 注册了通用工具集', () => {
    expect(toolNames('general')).toEqual([
      'fetchWeatherInfo',
      'calculator',
      'web_search',
    ]);
  });

  it('listAgents 返回两个 agent', () => {
    expect(listAgents().map((a) => a.id).sort()).toEqual(['editor', 'general']);
  });

  it('未知 agent 返回 undefined', () => {
    expect(getAgent('nope')).toBeUndefined();
  });
});

describe('AgentRunner', () => {
  it('把系统提示 + 历史 + 本轮问题组装成消息', async () => {
    const runner = mkRunner();
    const agent = getAgent('general')!;
    const events: any[] = [];
    // 用一个会吐内容的 fake：直接验证 runner 组装的消息被编排器使用
    const runnerWithCapture = (() => {
      let captured: any = null;
      const clients = new ModelClients(
        { chat: { completions: { create: vi.fn(async () => streamOf([{ choices: [{ delta: { content: 'ok' } }] }])) } } } as never,
        {
          chat: {
            completions: {
              create: vi.fn(async (payload: any) => {
                captured = payload;
                return streamOf([]);
              }),
            },
          },
        } as never,
      );
      const orchestrator = new AgentOrchestrator({
        getClient: (p) => clients.getClient(p),
        modelConfig: loadModelCascadeConfig(),
        showRoutingThought: false,
        rateLimitRetries: 0,
        zhipuLock: new SimpleLock(),
      });
      return { runner: new AgentRunner(orchestrator), getCaptured: () => captured };
    })();

    for await (const ev of runnerWithCapture.runner.run(agent, {
      query: '你好',
      history: [{ role: 'user', content: '旧问题' }],
    })) {
      events.push(ev);
    }

    const messages = runnerWithCapture.getCaptured().messages as any[];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('toto');
    expect(messages.some((m) => m.role === 'user' && m.content === '旧问题')).toBe(true);
    expect(messages.at(-1)).toEqual({ role: 'user', content: '你好' });
  });

  it('工具调用会被执行并把结果回填', async () => {
    const toolDelta = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'c1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"nope.txt"}' },
              },
            ],
          },
        },
      ],
    };
    const clients = new ModelClients(
      { chat: { completions: { create: vi.fn(async () => streamOf([])) } } } as never,
      { chat: { completions: { create: vi.fn(async () => streamOf([toolDelta])) } } } as never,
    );
    const orchestrator = new AgentOrchestrator({
      getClient: (p) => clients.getClient(p),
      modelConfig: loadModelCascadeConfig(),
      showRoutingThought: false,
      rateLimitRetries: 0,
      zhipuLock: new SimpleLock(),
    });
    const runner = new AgentRunner(orchestrator);

    const events: any[] = [];
    for await (const ev of runner.run(getAgent('editor')!, {
      query: '读取 nope.txt',
    })) {
      events.push(ev);
    }

    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall?.name).toBe('read_file');
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.result).toContain('文件不存在');
  });
});

describe('AgentRunner modelOverride', () => {
  it('客户端指定模型时覆盖后端级联', async () => {
    let captured: any = null;
    const clients = new ModelClients(
      {
        chat: {
          completions: {
            create: vi.fn(async (payload: any) => {
              captured = payload;
              return streamOf([{ choices: [{ delta: { content: 'ok' } }] }]);
            }),
          },
        },
      } as never,
      null,
    );
    const orchestrator = new AgentOrchestrator({
      getClient: (p) => clients.getClient(p),
      modelConfig: loadModelCascadeConfig(),
      showRoutingThought: false,
      rateLimitRetries: 0,
      zhipuLock: new SimpleLock(),
    });
    const runner = new AgentRunner(orchestrator);

    for await (const _ev of runner.run(getAgent('general')!, {
      query: '你好',
      modelOverride: 'qwen3.7-flash',
    })) {
      /* drain */
    }

    expect(captured.model).toBe('qwen3.7-flash');
  });
});

describe('editor 文件工具安全', () => {
  it('拒绝越界路径', async () => {
    const read = getAgent('editor')!.tools.find(
      (t) => t.definition.function.name === 'read_file',
    )!;
    const result = await read.handler({ path: '../../etc/passwd' });
    expect(result).toContain('越界');
  });

  it('拒绝破坏性终端命令', async () => {
    const run = getAgent('editor')!.tools.find(
      (t) => t.definition.function.name === 'run_terminal',
    )!;
    const result = await run.handler({ command: 'rm -rf /' });
    expect(result).toContain('拒绝');
  });
});
