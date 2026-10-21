import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourceUrl = new URL('../../components/ProductDemoView.tsx', import.meta.url);
const source = readFileSync(fileURLToPath(sourceUrl), 'utf8');

test('customer walkthrough covers the full product journey and all five guided chapters', () => {
  for (const phrase of [
    'Connect your channels',
    'Plan a campaign',
    'Prepare creative assets',
    'Review budgets safely',
    'Measure and optimize',
    'What the customer does',
    'The end-to-end workflow',
  ]) assert.ok(source.includes(phrase), `Expected product walkthrough content: ${phrase}`);
});

test('demo video integration accepts only HTTPS and recognized public video hosts/formats', () => {
  assert.match(source, /url\.protocol !== 'https:'/);
  assert.match(source, /youtube-nocookie\.com\/embed/);
  assert.match(source, /player\.vimeo\.com\/video/);
  assert.match(source, /endsWith\('\.mp4'\)/);
  assert.match(source, /VITE_PRODUCT_DEMO_VIDEO_URL/);
});

test('walkthrough explicitly discloses that demo guidance does not imply live ad execution', () => {
  assert.match(source, /does not execute live provider-side budget changes/i);
  assert.match(source, /does not publish live ads/i);
  assert.match(source, /demo data/i);
});
