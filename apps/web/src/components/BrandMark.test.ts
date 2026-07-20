// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import BrandMark from './BrandMark.svelte';

describe('BrandMark', () => {
  afterEach(cleanup);

  it('renders the local vector as a decorative image with an explicit size', () => {
    const { container } = render(BrandMark, { size: 'large' });
    const mark = container.querySelector('[data-brand-mark]');
    const image = container.querySelector('img');

    expect(mark?.getAttribute('data-size')).toBe('large');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(image?.getAttribute('src')).toContain('byteql');
    expect(image?.getAttribute('alt')).toBe('');
  });
});
