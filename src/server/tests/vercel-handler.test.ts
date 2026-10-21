import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import apiHandler from '../../../api/[...path].js';

test('Vercel API adapter routes protected requests to the secured Express router', async () => {
  const server = apiHandler.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/context`, {
      headers: { 'x-request-id': 'test-request-id' },
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('x-request-id'), 'test-request-id');
    assert.equal(response.headers.get('x-powered-by'), null);
    const body = await response.json() as { error?: string };
    assert.equal(body.error, 'UNAUTHENTICATED');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
});
