import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { MovablePane } = await import('./MovablePane');
const { setRegionBody, usePaneHostsStore } = await import('./regionHosts');

const REGION_KEYS = ['leaf-a', 'leaf-b', 'leaf-c'] as const;

// Stands in for a keep-alive surface: counts its mounts and holds an edit
// that only survives if the component and its DOM do.
let mounts = 0;
const Surface: React.FC = () => {
  React.useEffect(() => {
    mounts += 1;
  }, []);
  return <input data-testid="draft" defaultValue="" />;
};

let container: HTMLElement;
let root: Root;
const bodies = {
  'leaf-a': document.createElement('div'),
  'leaf-b': document.createElement('div'),
  'leaf-c': document.createElement('div'),
} satisfies Record<(typeof REGION_KEYS)[number], HTMLElement>;

const render = async (hostKey: string | null) => {
  await act(async () => {
    // Mounted whatever the key: a tab without a region keeps its pane
    // mounted; only unmounting the root takes it away for good.
    root.render(<MovablePane hostKey={hostKey}><Surface /></MovablePane>);
  });
};

beforeEach(() => {
  mounts = 0;
  container = document.createElement('div');
  document.body.append(container);
  for (const key of REGION_KEYS) {
    bodies[key].replaceChildren();
    document.body.append(bodies[key]);
    setRegionBody(key, bodies[key]);
  }
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  usePaneHostsStore.setState({ byKey: {} });
  document.body.innerHTML = '';
});

describe('MovablePane', () => {
  test('moving to another region keeps the same component and its uncommitted edit', async () => {
    await render('leaf-a');
    const input = bodies['leaf-a'].querySelector('input');
    expect(input).not.toBeNull();
    if (input) input.value = 'unsaved';

    await render('leaf-b');
    expect(bodies['leaf-a'].querySelector('input')).toBeNull();
    expect(bodies['leaf-b'].querySelector('input')).toBe(input);
    expect(input?.value).toBe('unsaved');

    await render('leaf-c');
    expect(bodies['leaf-c'].querySelector('input')).toBe(input);
    expect(mounts).toBe(1);
  });

  test('a region whose body appears later receives the pane then', async () => {
    setRegionBody('leaf-a', null);
    await render('leaf-a');
    expect(document.querySelector('input')?.isConnected ?? false).toBe(false);

    await act(async () => setRegionBody('leaf-a', bodies['leaf-a']));
    expect(bodies['leaf-a'].querySelector('input')).not.toBeNull();
  });

  test('a tab with no region keeps its pane alive off-document', async () => {
    await render('leaf-a');
    const input = bodies['leaf-a'].querySelector('input');
    expect(input).not.toBeNull();

    await render(null);
    expect(document.querySelector('input')).toBeNull();
    // Back in a region: the same instance, not a remount.
    await render('leaf-b');
    expect(bodies['leaf-b'].querySelector('input')).toBe(input);
    expect(mounts).toBe(1);
  });

  test('unmounting takes the pane out of its region', async () => {
    await render('leaf-a');
    await act(async () => root.unmount());
    expect(bodies['leaf-a'].childElementCount).toBe(0);
  });
});
