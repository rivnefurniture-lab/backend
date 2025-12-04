# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Install Python for backtest scripts
RUN apk add --no-cache python3 py3-pip

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

# Copy necessary files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts

# Create static directory
RUN mkdir -p static && chown -R nestjs:nodejs /app

# Install Python dependencies (using virtual env to avoid system issues)
RUN python3 -m venv /app/venv && \
    /app/venv/bin/pip install --upgrade pip && \
    /app/venv/bin/pip install ccxt pandas numpy ta pyarrow

# Add venv to PATH
ENV PATH="/app/venv/bin:$PATH"

USER nestjs

# Expose port
EXPOSE 8080

# Start the application
CMD ["node", "dist/src/main.js"]
