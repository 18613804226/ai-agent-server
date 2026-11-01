import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import { diffLines } from '../diff';
import type { FileEdit } from '../mode/types';

export interface CodeEditorHandle {
  applyStreamingEdit: (edit: FileEdit) => Promise<void>;
  focus: () => void;
  getValue: () => string;
  getSelection: () => string;
}

interface CodeEditorProps {
  path: string;
  value: string;
  onChange?: (value: string) => void;
}

function languageFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'javascript';
    case 'json':
      return 'json';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'css':
    case 'scss':
    case 'less':
      return 'css';
    case 'html':
    case 'htm':
    case 'vue':
      return 'html';
    case 'py':
      return 'python';
    default:
      return 'plaintext';
  }
}

/** 统一换行符，避免 Windows \r\n 文件与 AI 生成的 \n 内容做 diff 时全部不匹配 */
const normalizeEol = (s: string): string => s.replace(/\r\n/g, '\n');

/**
 * Monaco Editor + Cline 风格流式编辑动画。
 *
 * 设计要点：
 * - streamingRef 在动画期间阻止 value effect 覆盖编辑器内容
 * - 插入行时带 \n，删除行时整行（含换行符）一起删，避免行拼接/空行残留
 * - 动画结束用 setValue(after) 兜底，保证最终内容与工具写入结果完全一致
 * - 并发编辑通过 promise 队列串行化
 */
export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(
  ({ path, value, onChange }, ref) => {
    const host = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const modelRef = useRef<monaco.editor.ITextModel | null>(null);
    const onChangeRef = useRef(onChange);
    const valueRef = useRef(value);
    const streamingRef = useRef(false);
    /** 流式编辑队列：保证多个 file_edit 串行执行，不互相覆盖 */
    const queueRef = useRef<Promise<void>>(Promise.resolve());
    const [streaming, setStreaming] = useState(false);

    onChangeRef.current = onChange;
    valueRef.current = value;

    useEffect(() => {
      if (!host.current) return;

      const model = monaco.editor.createModel(value, languageFor(path));
      modelRef.current = model;

      const editor = monaco.editor.create(host.current, {
        model,
        theme: 'vs-dark',
        automaticLayout: true,
        fontSize: 13,
        minimap: { enabled: false },
        scrollbar: { vertical: 'visible', horizontal: 'visible' },
        wordWrap: 'on',
        renderWhitespace: 'boundary',
        padding: { top: 12 },
        lineNumbers: 'on',
        folding: true,
        renderLineHighlight: 'all',
        glyphMargin: false,
        contextmenu: true,
      });
      editorRef.current = editor;

      editor.onDidChangeModelContent(() => {
        // 动画期间不向外报变更，避免父组件刷新覆盖
        if (streamingRef.current) return;
        onChangeRef.current?.(model.getValue());
      });

      return () => {
        editor.dispose();
        model.dispose();
      };
      // 只在切换文件时重建编辑器；内容更新走下面的 value effect
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path]);

    /**
     * 同步外部 value 到编辑器。动画期间跳过，避免被覆盖。
     */
    useEffect(() => {
      if (streamingRef.current) return;
      const model = modelRef.current;
      if (!model) return;
      if (model.getValue() !== value) {
        model.setValue(value);
      }
    }, [value]);

    /**
     * 单次流式编辑：先显示 before，再按 diff 顺序逐行增删。
     */
    const runStreamingEdit = async (edit: FileEdit): Promise<void> => {
      const editor = editorRef.current;
      const model = modelRef.current;
      if (!editor || !model) {
        console.warn('[CodeEditor] applyStreamingEdit: editor/model not ready');
        return;
      }

      // before 未提供时读当前编辑器内容（工具还没执行，编辑器里是旧内容）
      const before = normalizeEol(edit.before ?? model.getValue());

      // 计算 after：
      // - write_file / apply_patch(content)：直接给完整 after
      // - edit_file / apply_patch(old/new)：根据 old_string/new_string 替换
      //   （与工具实现一致：split + join，全部替换）
      let after = edit.after;
      if (after === undefined && edit.old_string !== undefined) {
        after = before.split(edit.old_string).join(edit.new_string ?? '');
      }
      if (after === undefined) after = '';
      after = normalizeEol(after);

      console.log('[CodeEditor] streaming edit start', {
        path: edit.path,
        kind: edit.kind,
        beforeLines: before.split('\n').length,
        afterLines: after.split('\n').length,
      });

      // 先显示 before 内容
      if (model.getValue() !== before) {
        model.setValue(before);
      }
      editor.revealLineNearTop(1);

      // 标记动画开始（在任何 model 修改之前设置，防止触发 onChange）
      streamingRef.current = true;
      setStreaming(true);
      const addedDecorations: string[] = [];

      try {
        const diffs = diffLines(before, after);
        const changeCount = diffs.filter((d) => d.type !== 'same').length;
        // 大 diff 加快节奏，避免动画拖太久
        const stepDelay = changeCount > 60 ? 25 : changeCount > 30 ? 45 : 80;
        const delHoldMs = Math.min(200, stepDelay * 2);

        let lineNo = 1;

        for (const line of diffs) {
          if (line.type === 'same') {
            lineNo++;
            continue;
          }

          await new Promise((r) => setTimeout(r, stepDelay));

          const lineCount = model.getLineCount();

          if (line.type === 'del') {
            if (lineNo > lineCount) break;
            const content = model.getLineContent(lineNo);
            // 先加红色装饰，让用户看到要删的行
            const delDeps = editor.deltaDecorations(
              [],
              [
                {
                  range: new monaco.Range(lineNo, 1, lineNo, content.length + 1),
                  options: {
                    isWholeLine: true,
                    className: 'streaming-del',
                    marginClassName: 'streaming-del-margin',
                  },
                },
              ],
            );
            // 让用户看到红色高亮
            await new Promise((r) => setTimeout(r, delHoldMs));
            // 整行删除（含换行符），避免留下空行导致后续行号错位
            let delRange: monaco.Range;
            if (lineNo < lineCount) {
              // 非末行：删到下一行开头（覆盖换行符）
              delRange = new monaco.Range(lineNo, 1, lineNo + 1, 1);
            } else if (lineNo > 1) {
              // 末行：连前一个换行符一起删
              const prevLen = model.getLineContent(lineNo - 1).length;
              delRange = new monaco.Range(
                lineNo - 1,
                prevLen + 1,
                lineNo,
                content.length + 1,
              );
            } else {
              // 只有一行：清空内容
              delRange = new monaco.Range(lineNo, 1, lineNo, content.length + 1);
            }
            model.applyEdits([
              { range: delRange, text: '', forceMoveMarkers: true },
            ]);
            editor.deltaDecorations(delDeps, []);
            editor.revealLine(lineNo);
            // 删除后 lineNo 不变，下一行变成当前行
          } else if (line.type === 'add') {
            // 插入新行：带换行符，避免与现有行拼接
            if (lineNo <= lineCount) {
              model.applyEdits([
                {
                  range: new monaco.Range(lineNo, 1, lineNo, 1),
                  text: line.text + '\n',
                  forceMoveMarkers: true,
                },
              ]);
            } else {
              // 末尾追加：前导换行符
              const lastLen = model.getLineContent(lineCount).length;
              model.applyEdits([
                {
                  range: new monaco.Range(
                    lineCount,
                    lastLen + 1,
                    lineCount,
                    lastLen + 1,
                  ),
                  text: '\n' + line.text,
                  forceMoveMarkers: true,
                },
              ]);
            }
            // 绿色装饰
            const addDeps = editor.deltaDecorations(
              [],
              [
                {
                  range: new monaco.Range(lineNo, 1, lineNo, 1),
                  options: {
                    isWholeLine: true,
                    className: 'streaming-add',
                    marginClassName: 'streaming-add-margin',
                  },
                },
              ],
            );
            addedDecorations.push(...addDeps);
            editor.revealLine(lineNo);
            lineNo++;
          }
        }

        // 兜底：确保最终内容与 after 完全一致（修正尾部换行等细微差异）
        if (model.getValue() !== after) {
          model.setValue(after);
        }

        // 高亮持续 600ms 后清除
        await new Promise((r) => setTimeout(r, 600));
        editor.deltaDecorations(addedDecorations, []);
        console.log('[CodeEditor] streaming edit done');
      } catch (e) {
        console.error('[CodeEditor] 流式编辑出错', e);
      } finally {
        streamingRef.current = false;
        setStreaming(false);
      }
    };

    /**
     * 对外暴露的流式编辑入口：把编辑任务串到队列里顺序执行，
     * 避免多个 file_edit 并发时互相覆盖模型内容。
     */
    const applyStreamingEdit = async (edit: FileEdit): Promise<void> => {
      const next = queueRef.current.then(() => runStreamingEdit(edit));
      queueRef.current = next.catch(() => {});
      return next;
    };

    useImperativeHandle(
      ref,
      () => ({
        applyStreamingEdit,
        focus: () => editorRef.current?.focus(),
        getValue: () => modelRef.current?.getValue() ?? '',
        getSelection: () => {
          const editor = editorRef.current;
          const model = modelRef.current;
          const selection = editor?.getSelection();
          if (!editor || !model || !selection) return '';
          return model.getValueInRange(selection);
        },
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [applyStreamingEdit],
    );

    return (
      <div
        className="code-editor"
        ref={host}
        data-streaming={streaming || undefined}
      />
    );
  },
);