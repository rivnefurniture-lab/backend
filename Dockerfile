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

# Install Python and required packages for backtesting
RUN apk add --no-cache python3 py3-pip py3-pandas py3-numpy && \
    ln -sf python3 /usr/bin/python

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/static ./static
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/data ./data

RUN chown -R nestjs:nodejs /app

USER nestjs

EXPOSE 8080

# Optionally run migrations on start (set MIGRATE_ON_START=true) then start app
CMD ["sh", "-c", "if [ \"$MIGRATE_ON_START\" = \"true\" ]; then MIGRATION_URL=${DIRECT_DATABASE_URL:-$DATABASE_URL} DATABASE_URL=$MIGRATION_URL npx prisma migrate deploy; fi; node dist/src/main.js"]
