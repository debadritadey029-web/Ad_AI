# Enterprise Production Dockerfile for AdVantage AI
# Multi-stage build for optimal image size and security

FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first for build caching
COPY package.json ./
RUN npm install --ignore-scripts

# Copy source code and build production client
COPY . .
RUN npm run build

# ----------------------------------------------------------------------------
# Runner stage
# ----------------------------------------------------------------------------
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy dependencies and built assets
COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/server.ts ./
COPY --from=builder /app/tsconfig.json ./

# Create data directory for atomic state persistence
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["npm", "start"]
