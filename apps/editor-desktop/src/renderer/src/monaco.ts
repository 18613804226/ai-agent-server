/**
 * Monaco Editor worker 初始化。
 *
 * Monaco 在浏览器里需要把 editor/json/html/css/typescript worker 跑在独立 web worker 上。
 * 用 Vite/Rolldown 的 `?worker` 后缀把 worker 代码单独打包，按语言标签分发。
 */
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

let initialized = false;

export function setupMonacoWorkers(): void {
  if (initialized) return;
  initialized = true;

  window.MonacoEnvironment = {
    getWorker(_moduleLabel: string, label: string) {
      switch (label) {
        case 'json':
          return new JsonWorker();
        case 'css':
          return new CssWorker();
        case 'html':
          return new HtmlWorker();
        case 'typescript':
        case 'javascript':
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };
}