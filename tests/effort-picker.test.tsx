// jsdom render test: the effort picker must offer an "Auto" entry that saves
// effort: 'auto' through the selection route. Runs in Node with jsdom globals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const w = dom.window as any;
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'CustomEvent', 'Event', 'DocumentFragment', 'SVGElement', 'DOMRect', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'Document'])
  if (w[key] !== undefined)
    Object.defineProperty(globalThis, key, { value: w[key], configurable: true, writable: true });
(globalThis as any).self = w;
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
w.HTMLElement.prototype.setPointerCapture ??= function () {};
w.HTMLElement.prototype.releasePointerCapture ??= function () {};
w.HTMLElement.prototype.hasPointerCapture ??= function () { return false; };
w.Element.prototype.scrollIntoView ??= function () {};
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const selection = { connectionId: 'c1', modelId: 'm1', effort: 'low' };
const modelsFixture: any = {
  selection,
  connections: [
    {
      id: 'c1',
      provider: 'groq',
      status: 'connected',
      method: 'api_key',
      models: [
        { id: 'm1', name: 'model one', efforts: ['off', 'low', 'high'] },
      ],
    },
  ],
};

test('effort picker offers Auto and saves effort auto', async () => {
  const { pageDataCache } = await import('../src/web/lib/page-data-cache.ts');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { EffortPicker } = await import('../src/web/components/effort-picker.tsx');

  const calls: { path: string; method?: string; body?: string }[] = [];
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (path: any, options: any = {}) => {
    calls.push({ path: String(path), method: options.method ?? 'GET', body: options.body });
    const payload = path === '/api/models' ? modelsFixture : { ...modelsFixture, selection: { ...selection, effort: 'auto' } };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  pageDataCache.update('/api/models', () => modelsFixture);

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(EffortPicker));
  });

  const toggle = container.querySelector('button.effort-picker-toggle');
  assert.ok(toggle, 'picker toggle rendered (model has 3 efforts)');
  assert.match(toggle!.getAttribute('aria-label') ?? '', /Thinking level: Low/);

  await React.act(async () => {
    toggle!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  const items = [...document.querySelectorAll('[role="menuitemradio"]')] as HTMLElement[];
  const texts = items.map((item) => item.textContent ?? '');
  assert.ok(texts.some((t) => /Auto/.test(t)), `Auto entry present, got: ${JSON.stringify(texts)}`);
  assert.ok(
    texts.some((t) => /Lighter on simple requests \(structure heuristic, not understanding\), never above default/.test(t)),
    'auto hint shown, labeled heuristic not semantic',
  );
  const autoItem = items.find((item) => /Auto/.test(item.textContent ?? ''))!;
  assert.equal(autoItem.getAttribute('aria-checked'), 'false');

  await React.act(async () => {
    autoItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const put = calls.find((call) => call.path === '/api/models/selection' && call.method === 'PUT');
  assert.ok(put, `PUT /api/models/selection issued, got: ${JSON.stringify(calls)}`);
  assert.deepEqual(JSON.parse(put!.body ?? '{}'), { connectionId: 'c1', modelId: 'm1', effort: 'auto' });

  await React.act(async () => {
    root.unmount();
  });
  (globalThis as any).fetch = realFetch;
});
