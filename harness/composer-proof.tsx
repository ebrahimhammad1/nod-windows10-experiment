import '../src/web/theme.css';
import '../src/web/styles.css';
import '../src/web/components/composer.css';
import '../src/web/components/action-menu.css';
import '../src/web/components/tooltip.css';
import '../src/web/components/attachment-card.css';
import '../src/web/components/artifact-drawer.css';
import '../src/web/components/emoji-picker.css';
import '../src/web/pages/chat.css';
import { createRoot } from 'react-dom/client';
import { createElement, useEffect, useState } from 'react';
import { Composer } from '../src/web/components/composer';
import { EffortPicker } from '../src/web/components/effort-picker';
import { pageDataCache } from '../src/web/lib/page-data-cache';

const modelsFixture: any = {
  selection: { connectionId: 'c1', modelId: 'm1', effort: 'low' },
  connections: [
    {
      id: 'c1',
      provider: 'groq',
      status: 'connected',
      method: 'api_key',
      models: [
        { id: 'm1', name: 'qwen/qwen3.8-27b', efforts: ['off', 'low', 'high'] },
      ],
    },
  ],
};
pageDataCache.update('/api/models', () => modelsFixture);
(globalThis as any).fetch = async (path: any) => {
  if (String(path) === '/api/models')
    return new Response(JSON.stringify(modelsFixture), {
      headers: { 'content-type': 'application/json' },
    });
  return new Response('{}', { headers: { 'content-type': 'application/json' } });
};

function App() {
  const [text, setText] = useState('');
  useEffect(() => {
    if (location.search.includes('open=1')) {
      const timer = setTimeout(() => {
        document.querySelector<HTMLButtonElement>('button.effort-picker-toggle')?.click();
      }, 400);
      return () => clearTimeout(timer);
    }
  }, []);
  return createElement(
    'div',
    { style: { width: 720, margin: '40px auto', fontFamily: 'sans-serif' } },
    createElement('p', { style: { color: '#666', fontSize: 13 } }, 'Composer harness (fixture models)'),
    createElement(Composer, {
      accessory: createElement(EffortPicker),
      ready: true,
      text,
      setText,
      replyTo: null,
      clearReply: () => {},
      onSend: async () => ({ sent: true }) as any,
    }),
  );
}
createRoot(document.getElementById('root')!).render(createElement(App));
