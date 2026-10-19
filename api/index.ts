/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import dotenv from 'dotenv';
import { apiRouter } from '../src/server/routes.js';
import { securityHeaders, errorHandler } from '../src/server/middleware/security.js';

dotenv.config();

const app = express();

// Security headers & JSON parser
app.use(securityHeaders);
app.use(express.json({ limit: '1mb' }));

// Mount enterprise API router
app.use('/api', apiRouter);

// Centralized error handler
app.use(errorHandler);

export default app;
