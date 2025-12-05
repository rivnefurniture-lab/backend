# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

RUN mkdir -p static scripts && chown -R nestjs:nodejs /app

USER nestjs

EXPOSE 8080

# Sync database schema, then start app (continue even if db push has warnings)
CMD ["sh", "-c", "(npx prisma db push --accept-data-loss --skip-generate 2>&1 || echo 'DB push had issues, continuing...') && node dist/src/main.js"]
