import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { WELCOME_MD } from '../welcome';

export function Welcome({ onOpenDemo }: { onOpenDemo?: () => void }) {
  return (
    <div className="welcome">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{WELCOME_MD}</ReactMarkdown>
      {onOpenDemo ? (
        <div className="welcome-demo">
          <button
            type="button"
            className="ghost"
            onClick={onOpenDemo}
          >
            打开内置演示文件夹
          </button>
          <p className="welcome-demo-hint">
            演示文件夹在应用数据目录的 demo-workspace，可随意修改或删除。
          </p>
        </div>
      ) : null}
    </div>
  );
}
