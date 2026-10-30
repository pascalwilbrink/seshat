import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Home } from './home';

describe('Home', () => {
  it('renders the title', () => {
    expect(renderToStaticMarkup(<Home />)).toContain('<h1>Seshat</h1>');
  });
});
