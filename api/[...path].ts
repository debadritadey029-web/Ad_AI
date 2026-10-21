/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Vercel Node.js catch-all function for the Express API.
 * Keep this entrypoint thin: application routes and authorization live in src/server.
 */
import express from 'express';
import { apiRouter } from '../src/server/routes.js';
import { errorHandler, securityHeaders } from '../src/server/middleware/security.js';

const app = express();

// Vercel terminates TLS and forwards one trusted proxy hop.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.json({ limit: '1mb' }));

// Some serverless adapters expose the path relative to the function. Normalize
// that shape while preserving the query string; do not rewrite already-prefixed URLs.
app.use((req, _res, next) => {
  if (!req.path.startsWith('/api/')) {
    req.url = `/api${req.url.startsWith('/') ? '' : '/'}${req.url}`;
  }
  next();
});

app.use('/api', apiRouter);
app.use(errorHandler);

export default app;
