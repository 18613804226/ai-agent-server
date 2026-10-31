import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import type { FileChange } from '../mode/types';

/**
 * Monaco 内置的 diff 视图：左右对比 + 高亮差异行。
 * 比手写 diff 更可靠，且自带滚动同步。
 */
export function DiffView({ change }: { change: FileChange }) {
  const host = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<monaco.editor.IDiffEditor | null>(null);

  useEffect(() => {
    if (!host.current) return;

    const originalModel = monaco.editor.createModel(
      change.before ?? '',
      'plaintext',
    );
    const modifiedModel = monaco.editor.createModel(
      change.after ?? '',
      'plaintext',
    );

    const diffEditor = monaco.editor.createDiffEditor(host.current, {
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      scrollbar: { vertical: 'visible', horizontal: 'visible' },
      wordWrap: 'on',
      renderSideBySide: true,
      ignoreTrimWhitespace: false,
      renderIndicators: true,
    });
    diffEditorRef.current = diffEditor;
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });

    return () => {
      diffEditor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [change.path]);

  // 内容变化时同步
  useEffect(() => {
    const editor = diffEditorRef.current;
    if (!editor) return;
    const modified = editor.getModifiedEditor();
    if (modified && modified.getValue() !== (change.after ?? '')) {
      modified.setValue(change.after ?? '');
    }
  }, [change.after]);

  if (change.kind === 'renamed') {
    return (
      <div className="diff-empty">
        已重命名：{change.from} → {change.path}
      </div>
    );
  }

  return <div className="diff" ref={host} />;
}
