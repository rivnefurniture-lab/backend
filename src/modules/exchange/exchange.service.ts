import { BadRequestException, Injectable } from '@nestjs/common';
import { binance, bybit, Exchange, okx } from 'ccxt';

interface Connection {
  instance: Exchange;
  apiKey: string;
  secret: string;
  password?: string;
  testnet: boolean;
}

@Injectable()
export class ExchangeService {
  private connections: Record<string, Connection> = {};

  makeExchange(id: string, creds: Connection): Exchange {
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

  async connect(exchange: string, creds: Omit<Connection, 'instance'>) {
    const instance = this.makeExchange(exchange, {
      ...creds,
      instance: null,
    } as any);
    await instance.loadMarkets();
    this.connections[exchange] = { ...creds, instance };
    return { ok: true };
  }

  getConnection(exchange: string): Connection {
    const conn = this.connections[exchange];
    if (!conn) throw new BadRequestException('Not connected');
    return conn;
  }

  async getBalance(exchange: string) {
    const conn = this.getConnection(exchange);
    return conn.instance.fetchBalance();
  }

  async getMarkets(exchange: string) {
    const conn = this.getConnection(exchange);
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
  ) {
    const conn = this.getConnection(exchange);
    const ex = conn.instance;
    await ex.loadMarkets();
    const amt = ex.amountToPrecision(symbol, amountBase);
    return await ex.createOrder(symbol, 'market', side, amt);
  }
}
