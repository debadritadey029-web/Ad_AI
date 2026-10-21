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


test('Vercel API liveness does not disclose tenant counts and readiness fails closed', async () => {
  const server = apiHandler.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;

  try {
    const liveResponse = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(liveResponse.status, 200);
    const liveBody = await liveResponse.json() as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(liveBody, 'activeCounts'), false);
    assert.equal((liveBody.persistence as { productionReady?: boolean }).productionReady, false);

    const readyResponse = await fetch(`http://127.0.0.1:${address.port}/api/health/ready`);
    assert.equal(readyResponse.status, 503);
    const readyBody = await readyResponse.json() as { ready?: boolean; productionReady?: boolean; blockers?: string[] };
    assert.equal(readyBody.ready, false);
    assert.equal(readyBody.productionReady, false);
    assert.ok(readyBody.blockers?.includes('DURABLE_TRANSACTIONAL_TENANT_PERSISTENCE_NOT_IMPLEMENTED'));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
});
