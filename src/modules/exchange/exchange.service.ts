import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { binance, bybit, Exchange, okx } from 'ccxt';
import { PrismaService } from '../../prisma/prisma.service';
import * as crypto from 'crypto';

interface Connection {
  instance: Exchange;
  apiKey: string;
  secret: string;
  password?: string;
  testnet: boolean;
}

// Simple encryption for API keys (use proper encryption in production)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'algotcha-secure-key-32ch';

function encrypt(text: string): string {
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text: string): string {
  try {
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const [ivHex, encrypted] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return '';
  }
}

@Injectable()
export class ExchangeService implements OnModuleInit {
  private connections: Record<string, Record<number, Connection>> = {}; // exchange -> userId -> Connection

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    // Load all active connections on startup (skip if table doesn't exist)
    console.log('Loading saved exchange connections...');
    try {
      const savedConnections = await this.prisma.exchangeConnection.findMany({
        where: { isActive: true },
      });
      
      for (const conn of savedConnections) {
        try {
          const apiKey = decrypt(conn.apiKeyEnc);
          const secret = decrypt(conn.secretEnc);
          const password = conn.passwordEnc ? decrypt(conn.passwordEnc) : undefined;
          
          if (apiKey && secret) {
            await this.connectInternal(conn.userId, conn.exchange, {
              apiKey,
              secret,
              password,
              testnet: conn.testnet,
            });
            console.log(`Restored ${conn.exchange} connection for user ${conn.userId}`);
          }
        } catch (e) {
          console.error(`Failed to restore connection:`, e);
        }
      }
      console.log(`Loaded ${savedConnections.length} exchange connections`);
    } catch (e) {
      console.log('ExchangeConnection table not found, skipping restore');
    }
  }

  makeExchange(id: string, creds: Omit<Connection, 'instance'>): Exchange {
    const common = {
      enableRateLimit: true,
      apiKey: creds.apiKey,
      secret: creds.secret,
      password: creds.password,
    };
    let ex: Exchange;
    if (id === 'binance') ex = new binance(common);
    else if (id === 'bybit') ex = new bybit(common);
    else if (id === 'okx') ex = new okx(common);
    else throw new BadRequestException('Unsupported exchange');

    if (creds.testnet) {
      Promise.resolve()
        .then(() => ex.setSandboxMode(true))
        .catch((err: unknown) => {
          if (err instanceof Error) {
            console.warn(`Failed to set sandbox mode: ${err.message}`);
          } else {
            console.warn('Failed to set sandbox mode:', err);
          }
        });

      if (id === 'binance') {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        ex.urls['api'] = {
          public: 'https://testnet.binance.vision/api',
          private: 'https://testnet.binance.vision/api',
        };
      }
      if (id === 'bybit') {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        ex.urls['api'] = {
          public: 'https://api-testnet.bybit.com',
          private: 'https://api-testnet.bybit.com',
        };
      }
    }
    return ex;
  }

  private async connectInternal(userId: number, exchange: string, creds: Omit<Connection, 'instance'>) {
    const instance = this.makeExchange(exchange, creds);
    await instance.loadMarkets();
    
    if (!this.connections[exchange]) {
      this.connections[exchange] = {};
    }
    this.connections[exchange][userId] = { ...creds, instance };
    return { ok: true };
  }

  async connect(userId: number, exchange: string, creds: Omit<Connection, 'instance'>) {
    // Connect to exchange
    await this.connectInternal(userId, exchange, creds);
    
    // Try to save to database (skip if table doesn't exist)
    try {
      await this.prisma.exchangeConnection.upsert({
        where: { userId_exchange: { userId, exchange } },
        create: {
          userId,
          exchange,
          apiKeyEnc: encrypt(creds.apiKey),
          secretEnc: encrypt(creds.secret),
          passwordEnc: creds.password ? encrypt(creds.password) : null,
          testnet: creds.testnet,
          isActive: true,
        },
        update: {
          apiKeyEnc: encrypt(creds.apiKey),
          secretEnc: encrypt(creds.secret),
          passwordEnc: creds.password ? encrypt(creds.password) : null,
          testnet: creds.testnet,
          isActive: true,
          connectedAt: new Date(),
        },
      });
    } catch (e) {
      console.log('Could not persist exchange connection to database');
    }

    return { ok: true };
  }

  async disconnect(userId: number, exchange: string) {
    // Remove from memory
    if (this.connections[exchange]?.[userId]) {
      delete this.connections[exchange][userId];
    }
    
    // Try to mark as inactive in database
    try {
      await this.prisma.exchangeConnection.updateMany({
        where: { userId, exchange },
        data: { isActive: false },
      });
    } catch (e) {
      console.log('Could not update database');
    }
    
    return { ok: true };
  }

  getConnection(exchange: string, userId?: number): Connection | null {
    if (userId && this.connections[exchange]?.[userId]) {
      return this.connections[exchange][userId];
    }
    // Fallback to first available connection for the exchange (legacy)
    const exchangeConns = this.connections[exchange];
    if (exchangeConns) {
      const firstUserId = Object.keys(exchangeConns)[0];
      if (firstUserId) {
        return exchangeConns[Number(firstUserId)];
      }
    }
    return null;
  }

  async getUserConnections(userId: number) {
    try {
      const dbConnections = await this.prisma.exchangeConnection.findMany({
        where: { userId, isActive: true },
        select: { exchange: true, testnet: true, connectedAt: true },
      });
      
      return dbConnections.map(c => ({
        exchange: c.exchange,
        testnet: c.testnet,
        connectedAt: c.connectedAt,
        isConnected: !!this.connections[c.exchange]?.[userId],
      }));
    } catch (e) {
      // Table doesn't exist, return in-memory connections
      const result: Array<{exchange: string; testnet: boolean; connectedAt: Date; isConnected: boolean}> = [];
      for (const [exchange, userConns] of Object.entries(this.connections)) {
        if (userConns[userId]) {
          result.push({
            exchange,
            testnet: userConns[userId].testnet,
            connectedAt: new Date(),
            isConnected: true,
          });
        }
      }
      return result;
    }
  }

  async getBalance(exchange: string, userId?: number) {
    const conn = this.getConnection(exchange, userId);
    if (!conn) throw new BadRequestException('Not connected');
    return conn.instance.fetchBalance();
  }

  async getMarkets(exchange: string, userId?: number) {
    const conn = this.getConnection(exchange, userId);
    if (!conn) throw new BadRequestException('Not connected');
    const markets = (await conn.instance.loadMarkets()) as Record<
      string,
      { symbol: string; spot: boolean }
    >;
    return Object.values(markets)
      .filter((m) => m.symbol.endsWith('/USDT') && m.spot)
      .slice(0, 100)
      .map((m) => m.symbol);
  }

  async createMarketOrder(
    exchange: string,
    symbol: string,
    side: 'buy' | 'sell',
    amountBase: number,
    userId?: number,
  ) {
    const conn = this.getConnection(exchange, userId);
    if (!conn) throw new BadRequestException('Not connected');
    const ex = conn.instance;
    await ex.loadMarkets();
    const amt = ex.amountToPrecision(symbol, amountBase);
    return await ex.createOrder(symbol, 'market', side, amt);
  }
}
