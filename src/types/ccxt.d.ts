declare module 'ccxt' {
  export class Exchange {
    constructor(config?: any);

    loadMarkets(): Promise<any>;

    fetchBalance(): Promise<any>;

    createOrder(
      symbol: string,
      type: string,
      side: string,
      amount: number,
      params?: any,
    ): Promise<any>;

    amountToPrecision(symbol: string, amount: number): number;

    setSandboxMode(enabled: boolean): void;

    market(symbol: string): any;

    [key: string]: any;
  }

  export class binance extends Exchange {}

  export class bybit extends Exchange {}

  export class okx extends Exchange {}
}
