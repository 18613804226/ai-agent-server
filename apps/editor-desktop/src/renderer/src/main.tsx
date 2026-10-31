import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ModeProvider } from './mode/ModeContext';
import { setupMonacoWorkers } from './monaco';
import './styles.css';

// Monaco 的 editor / language worker 必须在任何 Monaco 实例创建前就绪
setupMonacoWorkers();

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root');

createRoot(container).render(
  <React.StrictMode>
    <ModeProvider>
      <App />
    </ModeProvider>
  </React.StrictMode>,
);