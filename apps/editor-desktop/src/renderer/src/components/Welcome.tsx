import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { WELCOME_MD } from '../welcome';

export function Welcome() {
  return (
    <div className="welcome">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{WELCOME_MD}</ReactMarkdown>
    </div>
  );
}
