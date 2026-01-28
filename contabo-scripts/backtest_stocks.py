#!/usr/bin/env python3
"""
Backtest module for Stocks/Commodities
Uses Yahoo Finance data stored in parquet files
Same logic as crypto backtest but adapted for stocks
"""
import json
from datetime import datetime
import os
import pandas as pd
import numpy as np
from collections import defaultdict, deque
from concurrent.futures import as_completed, ThreadPoolExecutor

# Constants - will be overridden by backtest_worker
DATA_DIR = "/opt/algotcha/data/stocks"

ALL_TIMEFRAMES = ["1h", "4h", "1d"]

TIMEFRAME_TO_MINUTES = {
    "1h": 60, "4h": 240, "1d": 1440
}


def get_tf_priority(tf: str) -> int:
    return TIMEFRAME_TO_MINUTES.get(tf, 60)


def get_highest_timeframe(conditions):
    highest_tf = "1h"
    for cond in conditions:
        subs = cond.get("subfields", {})
        tf = subs.get("Timeframe", "1h")
        if get_tf_priority(tf) > get_tf_priority(highest_tf):
            highest_tf = tf
    return highest_tf


def get_user_payload(data):
    return {
        "strategy_name": data.get('strategy_name', ''),
        "pairs": data.get('pairs', []),
        "max_active_deals": data.get('max_active_deals', 0),
        "trading_fee": data.get('trading_fee', 0.0),
        "base_order_size": data.get('base_order_size', 0.0),
        "initial_balance": data.get('initial_balance', 10000.0),
        "start_date": data.get("start_date", ""),
        "end_date": data.get("end_date", ""),
        "entry_conditions": data.get('entry_conditions', []),
        "safety_order_toggle": data.get('safety_order_toggle', False),
        "safety_order_size": data.get('safety_order_size', 0.0),
        "price_deviation": data.get('price_deviation', 0.0),
        "max_safety_orders_count": data.get('max_safety_orders_count', 0),
        "safety_order_volume_scale": data.get('safety_order_volume_scale', 0.0),
        "safety_order_step_scale": data.get('safety_order_step_scale', 0.0),
        "safety_conditions": data.get('safety_conditions', []),
        "price_change_active": data.get('price_change_active', False),
        "conditions_active": data.get('conditions_active', False),
        "take_profit_type": data.get('take_profit_type', ''),
        "target_profit": data.get('target_profit', 0.0),
        "trailing_toggle": data.get('trailing_toggle', False),
        "trailing_deviation": data.get('trailing_deviation', 0.0),
        "exit_conditions": data.get('exit_conditions', []),
        "minprof_toggle": data.get('minprof_toggle', False),
        "minimal_profit": data.get('minimal_profit', 0),
        "reinvest_profit": data.get('reinvest_profit', 0.0),
        "stop_loss_toggle": data.get('stop_loss_toggle', False),
        "stop_loss_value": data.get('stop_loss_value', 0.0),
        "stop_loss_timeout": data.get('stop_loss_timeout', 0.0),
        "risk_reduction": data.get('risk_reduction', 0.0),
        "min_daily_volume": data.get('min_daily_volume', 0.0),
        "cooldown_between_deals": data.get('cooldown_between_deals', 0),
        "close_deal_after_timeout": data.get('close_deal_after_timeout', 0)
    }


def gather_required_columns(entry_conditions, safety_conditions, exit_conditions):
    """Gather required columns based on conditions"""
    required = {"timestamp", "open", "high", "low", "close", "volume"}
    tf_mapping = {
        "1h": "Bar_Close_1h", "4h": "Bar_Close_4h", "1d": "Bar_Close_1d"
    }

    def parse_one(cond):
        indicator = cond.get("indicator", "")
        subs = cond.get("subfields", {})
        tf = subs.get("Timeframe", "1h")
        cols = []

        if indicator == "RSI":
            length = subs.get("RSI Length", 14)
            col = f"RSI_{length}"
            if tf != "1h":
                col += f"_{tf}"
            cols.append(col)
        elif indicator == "MA":
            ma_type = subs.get("MA Type", "SMA")
            fast_ma = subs.get("Fast MA", 14)
            slow_ma = subs.get("Slow MA", 28)
            col_fast = f"{ma_type}_{fast_ma}"
            col_slow = f"{ma_type}_{slow_ma}"
            if tf != "1h":
                col_fast += f"_{tf}"
                col_slow += f"_{tf}"
            cols.extend([col_fast, col_slow])
        elif indicator == "BollingerBands":
            period = subs.get("BB% Period", 20)
            dev = subs.get("Deviation", 2)
            col = f"BB_%B_{period}_{dev}"
            if tf != "1h":
                col += f"_{tf}"
            cols.append(col)
        elif indicator == "MACD":
            preset = subs.get("MACD Preset", "12,26,9")
            fast_str, slow_str, sig_str = preset.split(',')
            main_col = f"MACD_{fast_str}_{slow_str}_{sig_str}"
            signal_col = f"MACD_{fast_str}_{slow_str}_{sig_str}_Signal"
            if tf != "1h":
                main_col += f"_{tf}"
                signal_col += f"_{tf}"
            cols.extend([main_col, signal_col])
        elif indicator == "Stochastic":
            stoch_preset = subs.get("Stochastic Preset", "14,3,3")
            k_str, ksmooth_str, dsmooth_str = stoch_preset.split(',')
            k_col = f"Stochastic_K_{k_str}_{ksmooth_str}"
            d_col = f"Stochastic_D_{k_str}_{ksmooth_str}_{dsmooth_str}"
            if tf != "1h":
                k_col += f"_{tf}"
                d_col += f"_{tf}"
            cols.extend([k_col, d_col])
        elif indicator == "ParabolicSAR":
            psar_str = subs.get("PSAR Preset", "0.02,0.2")
            step_str, max_str = psar_str.split(',')
            col = f"PSAR_AF_{step_str}_Max_{max_str}"
            if tf != "1h":
                col += f"_{tf}"
            cols.append(col)
        else:
            cols = []

        if tf in tf_mapping:
            cols.append(tf_mapping[tf])
        return cols, tf

    for cond in entry_conditions:
        cols, tf = parse_one(cond)
        for c in cols:
            required.add(c)
        if tf != "1h":
            required.add(f"close_{tf}")

    for cond in safety_conditions:
        cols, tf = parse_one(cond)
        for c in cols:
            required.add(c)
        if tf != "1h":
            required.add(f"close_{tf}")

    for cond in exit_conditions:
        cols, tf = parse_one(cond)
        for c in cols:
            required.add(c)
        if tf != "1h":
            required.add(f"close_{tf}")

    return list(required)


def load_parquets_in_parallel(pairs, required_cols):
    """Load parquet files for stock symbols"""
    results = {}
    
    def load_one(pair):
        # Stock symbols don't have slashes
        symbol = pair.replace('/', '_') if '/' in pair else pair
        file_path = os.path.join(DATA_DIR, f'{symbol}_all_tf_merged.parquet')
        
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"Parquet file not found for {pair}: {file_path}")
        
        # Read all columns first, then filter
        df = pd.read_parquet(file_path)
        
        # Filter to required columns that exist
        available_cols = [c for c in required_cols if c in df.columns]
        missing_cols = [c for c in required_cols if c not in df.columns]
        
        if missing_cols:
            print(f"Warning: Missing columns for {pair}: {missing_cols[:5]}...")
            
        df = df[available_cols].copy()
        
        if 'timestamp' in df.columns:
            df['timestamp'] = pd.to_datetime(df['timestamp'], errors='coerce')
        df = df.sort_values('timestamp').reset_index(drop=True)
        df['symbol'] = pair
        return pair, df

    with ThreadPoolExecutor(max_workers=4) as executor:
        fut_map = {executor.submit(load_one, p): p for p in pairs}
        for fut in as_completed(fut_map):
            pair = fut_map[fut]
            try:
                p, df = fut.result()
                results[p] = df
            except Exception as e:
                print(f"Error loading {pair} in parallel: {e}")
                raise
    return results


def check_all_user_conditions(row, conditions, prev_row=None):
    """Check if all conditions are met - same as crypto version"""
    if not conditions:
        return True

    for cond in conditions:
        indicator = cond.get("indicator", "")
        subs = cond.get("subfields", {})
        tf = subs.get("Timeframe", "1h")
        tf_mapping = {
            '1h': 'Bar_Close_1h', '4h': 'Bar_Close_4h', '1d': 'Bar_Close_1d'
        }
        
        bar_close_col = tf_mapping.get(tf)
        if bar_close_col and bar_close_col in row and not row[bar_close_col]:
            return False

        operator = subs.get("Condition", "")
        value = subs.get("Signal Value", None)

        if indicator == "RSI":
            length = subs.get("RSI Length", 14)
            col = f"RSI_{length}"
            if tf != "1h":
                col += f"_{tf}"
            row_val = row.get(col, None)
            if row_val is None or pd.isna(row_val):
                return False
            if operator == "Less Than":
                if value is None or not (row_val < value):
                    return False
            elif operator == "Greater Than":
                if value is None or not (row_val > value):
                    return False
            elif operator == "Crossing Down":
                if value is None or prev_row is None:
                    return False
                prev_val = prev_row.get(col, None)
                if prev_val is None or not (prev_val >= value and row_val < value):
                    return False
            elif operator == "Crossing Up":
                if value is None or prev_row is None:
                    return False
                prev_val = prev_row.get(col, None)
                if prev_val is None or not (prev_val <= value and row_val > value):
                    return False
                    
        elif indicator == "MA":
            ma_type = subs.get("MA Type", "SMA")
            fast_ma = subs.get("Fast MA", 14)
            slow_ma = subs.get("Slow MA", 28)
            col_fast = f"{ma_type}_{fast_ma}"
            col_slow = f"{ma_type}_{slow_ma}"
            if tf != "1h":
                col_fast += f"_{tf}"
                col_slow += f"_{tf}"
            val_fast = row.get(col_fast, None)
            val_slow = row.get(col_slow, None)
            if val_fast is None or val_slow is None or pd.isna(val_fast) or pd.isna(val_slow):
                return False
            if operator == "Less Than":
                if not (val_fast < val_slow):
                    return False
            elif operator == "Greater Than":
                if not (val_fast > val_slow):
                    return False
            elif operator == "Crossing Down":
                if prev_row is None:
                    return False
                prev_fast = prev_row.get(col_fast, None)
                prev_slow = prev_row.get(col_slow, None)
                if prev_fast is None or prev_slow is None:
                    return False
                if not (prev_fast >= prev_slow and val_fast < val_slow):
                    return False
            elif operator == "Crossing Up":
                if prev_row is None:
                    return False
                prev_fast = prev_row.get(col_fast, None)
                prev_slow = prev_row.get(col_slow, None)
                if prev_fast is None or prev_slow is None:
                    return False
                if not (prev_fast <= prev_slow and val_fast > val_slow):
                    return False
                    
        elif indicator == "BollingerBands":
            period = subs.get("BB% Period", 20)
            dev = subs.get("Deviation", 2)
            col = f"BB_%B_{period}_{dev}"
            if tf != "1h":
                col += f"_{tf}"
            row_val = row.get(col, None)
            if row_val is None or pd.isna(row_val):
                return False
            if operator == "Less Than":
                if value is None or not (row_val < value):
                    return False
            elif operator == "Greater Than":
                if value is None or not (row_val > value):
                    return False
                    
        elif indicator == "MACD":
            macd_preset = subs.get("MACD Preset", "12,26,9")
            fast_str, slow_str, sig_str = macd_preset.split(',')
            main_name = f"MACD_{fast_str}_{slow_str}_{sig_str}"
            signal_name = f"MACD_{fast_str}_{slow_str}_{sig_str}_Signal"
            if tf != "1h":
                main_name += f"_{tf}"
                signal_name += f"_{tf}"
            main_val = row.get(main_name, None)
            signal_val = row.get(signal_name, None)
            if main_val is None or signal_val is None or pd.isna(main_val) or pd.isna(signal_val):
                return False
            macd_trigger = subs.get("MACD Trigger", "")
            if macd_trigger == "Crossing Up":
                if prev_row is None:
                    return False
                prev_main = prev_row.get(main_name, None)
                prev_sig = prev_row.get(signal_name, None)
                if prev_main is None or prev_sig is None:
                    return False
                if not (prev_main <= prev_sig and main_val > signal_val):
                    return False
            elif macd_trigger == "Crossing Down":
                if prev_row is None:
                    return False
                prev_main = prev_row.get(main_name, None)
                prev_sig = prev_row.get(signal_name, None)
                if prev_main is None or prev_sig is None:
                    return False
                if not (prev_main >= prev_sig and main_val < signal_val):
                    return False
                    
        elif indicator == "Stochastic":
            stoch_preset = subs.get("Stochastic Preset", "14,3,3")
            k_str, ksmooth_str, dsmooth_str = stoch_preset.split(',')
            k_col = f"Stochastic_K_{k_str}_{ksmooth_str}"
            d_col = f"Stochastic_D_{k_str}_{ksmooth_str}_{dsmooth_str}"
            if tf != "1h":
                k_col += f"_{tf}"
                d_col += f"_{tf}"
            k_val = row.get(k_col, None)
            if k_val is None or pd.isna(k_val):
                return False
            k_cond = subs.get("K Condition", "")
            k_sig_val = subs.get("K Signal Value", None)
            if k_cond == "Less Than":
                if k_sig_val is None or not (k_val < k_sig_val):
                    return False
            elif k_cond == "Greater Than":
                if k_sig_val is None or not (k_val > k_sig_val):
                    return False
                    
        elif indicator == "ParabolicSAR":
            psar_str = subs.get("PSAR Preset", "0.02,0.2")
            step_str, max_str = psar_str.split(',')
            col = f"PSAR_AF_{step_str}_Max_{max_str}"
            if tf != "1h":
                col += f"_{tf}"
            row_val = row.get(col, None)
            if row_val is None or pd.isna(row_val):
                return False
            close_now = row.get('close', None)
            if close_now is None:
                return False
            if operator in ["Crossing (Long)", "Crossing (Short)"]:
                if prev_row is None:
                    return False
                prev_val = prev_row.get(col, None)
                close_prev = prev_row.get('close', None)
                if prev_val is None or close_prev is None:
                    return False
                if operator == "Crossing (Long)":
                    if not (close_prev <= prev_val and close_now > row_val):
                        return False
                elif operator == "Crossing (Short)":
                    if not (close_prev >= prev_val and close_now < row_val):
                        return False
        else:
            return False
            
    return True


def compute_metrics(df_out, initial_balance, payload, BACKTEST_RESULTS_DIR):
    """Compute backtest metrics - simplified version"""
    if df_out.empty:
        return {"status": "error", "message": "No trade data available."}
        
    last_realized = df_out["real_balance"].iloc[-1]
    last_total = df_out["unrealized_balance"].iloc[-1]
    total_profit = (last_total - initial_balance) / initial_balance
    total_profit_usd = round(last_total - initial_balance, 2)
    net_profit = (last_realized - initial_balance) / initial_balance
    net_profit_usd = round(last_realized - initial_balance, 2)

    df_out["timestamp"] = pd.to_datetime(df_out["timestamp"])
    start_ts = df_out["timestamp"].iloc[0]
    end_ts = df_out["timestamp"].iloc[-1]
    total_minutes = (end_ts - start_ts).total_seconds() / 60.0
    total_days = total_minutes / (60.0 * 24.0)
    
    if total_days <= 0:
        average_daily_profit = 0.0
    else:
        average_daily_profit = net_profit / total_days

    total_years = total_minutes / 525600.0
    if total_years > 0:
        yearly_return = (1 + net_profit) ** (1 / total_years) - 1
    else:
        yearly_return = 0.0

    gross_profit = 0.0
    gross_loss = 0.0
    total_trades = 0
    wins = 0
    
    if "profit_loss" in df_out.columns:
        for i, row in df_out.iterrows():
            act_lc = str(row["action"]).lower()
            pl = row["profit_loss"]
            if ("sell" in act_lc) or ("exit" in act_lc):
                total_trades += 1
                if pl > 0:
                    gross_profit += pl
                    wins += 1
                else:
                    gross_loss += abs(pl)

    if gross_loss > 0:
        profit_factor = gross_profit / gross_loss
    else:
        profit_factor = "Infinity" if gross_profit > 0 else 1.0

    win_rate = wins / total_trades if total_trades > 0 else 0.0

    # Sharpe and Sortino
    daily_bal = df_out.resample("1D", on="timestamp")["unrealized_balance"].last().ffill()
    daily_ret = daily_bal.pct_change().dropna()
    
    if len(daily_ret) > 1:
        sharpe_ratio = daily_ret.mean() / daily_ret.std() * np.sqrt(252)
    else:
        sharpe_ratio = 0.0

    neg_ret = daily_ret[daily_ret < 0]
    if len(neg_ret) > 0:
        downside_std = neg_ret.std()
        sortino_ratio = daily_ret.mean() / downside_std * np.sqrt(252) if downside_std > 0 else 0.0
    else:
        sortino_ratio = 0.0

    final_unreal_dd = df_out["max_drawdown"].iloc[-1] if "max_drawdown" in df_out.columns else 0.0

    metrics = {
        "net_profit": net_profit,
        "total_profit": total_profit,
        "net_profit_usd": f"${round(net_profit_usd, 2)}",
        "total_profit_usd": f"${round(total_profit_usd, 2)}",
        "average_daily_profit": average_daily_profit,
        "yearly_return": yearly_return,
        "profit_factor": profit_factor,
        "gross_profit": gross_profit,
        "gross_loss": gross_loss,
        "sharpe_ratio": sharpe_ratio,
        "sortino_ratio": sortino_ratio,
        "total_trades": total_trades,
        "win_rate": win_rate,
        "max_drawdown": final_unreal_dd,
    }

    chart_data = {
        "timestamps": df_out["timestamp"].astype(str).tolist(),
        "unrealized_balance": df_out["unrealized_balance"].tolist(),
    }

    return {
        "status": "success",
        "message": "Backtest completed successfully.",
        "metrics": metrics,
        "chartData": chart_data,
        "df_out": df_out.to_dict("records")
    }


def run_backtest(payload):
    """Main backtest function for stocks"""
    try:
        payload = get_user_payload(payload)
        
        pairs = payload.get("pairs", [])
        pairs.sort()
        strategy_name = payload.get("strategy_name", '')
        max_active_deals = payload.get("max_active_deals", 1)
        initial_balance = payload.get("initial_balance", 10000.0)
        
        if not pairs:
            return {"status": "error", "message": "No pairs/symbols selected."}

        trading_fee = payload.get("trading_fee", 0.0) / 100
        base_order_size = payload.get("base_order_size", 0.0)
        reinvest_profit = payload.get("reinvest_profit", 0.0)
        risk_reduction = payload.get("risk_reduction", 0.0)

        # Gather required columns
        req_cols = gather_required_columns(
            payload.get("entry_conditions", []),
            payload.get("safety_conditions", []),
            payload.get("exit_conditions", [])
        )
        
        print(f"Loading data for {len(pairs)} symbols...")
        dfs_map = load_parquets_in_parallel(pairs, req_cols)

        start_date = pd.to_datetime(payload.get("start_date", ""), errors="coerce")
        end_date = pd.to_datetime(payload.get("end_date", ""), errors="coerce")
        
        for sym, df in dfs_map.items():
            if start_date is not None and not pd.isnull(start_date):
                df = df[df["timestamp"] >= start_date]
            if end_date is not None and not pd.isnull(end_date):
                df = df[df["timestamp"] <= end_date]
            if df.empty:
                dfs_map[sym] = df
                continue
            if not pd.api.types.is_datetime64_any_dtype(df["timestamp"]):
                df["timestamp"] = pd.to_datetime(df["timestamp"])
            df["symbol"] = sym
            dfs_map[sym] = df

        all_df = pd.concat([df for df in dfs_map.values() if not df.empty], ignore_index=True)
        if all_df.empty:
            return {"status": "success", "message": "No data after filtering dates."}
            
        all_df.sort_values("timestamp", inplace=True)
        all_df.reset_index(drop=True, inplace=True)
        
        print(f"Total rows to process: {len(all_df)}")

        entry_conditions = payload.get("entry_conditions", [])
        exit_conditions = payload.get("exit_conditions", [])
        safety_conditions = payload.get("safety_conditions", [])
        safety_order_toggle = payload.get("safety_order_toggle", False)
        price_deviation = payload.get("price_deviation", 1.0)
        max_safety_orders = payload.get("max_safety_orders_count", 0)
        stop_loss_toggle = payload.get("stop_loss_toggle", False)
        stop_loss_value = payload.get("stop_loss_value", 0.0)
        price_change_active = payload.get("price_change_active", False)
        target_profit = payload.get("target_profit", 0.0)
        conditions_active = payload.get("conditions_active", False)
        minprof_toggle = payload.get("minprof_toggle", False)
        minimal_profit = payload.get("minimal_profit", 0) / 100
        cooldown_between_deals = payload.get("cooldown_between_deals", 0)

        dev_frac = price_deviation / 100.0 if safety_order_toggle and max_safety_orders > 0 else 0
        sl_frac = stop_loss_value / 100.0 if stop_loss_toggle and stop_loss_value > 0 else 0
        tp_frac = target_profit / 100.0 if target_profit > 0 else 0
        cooldown_delta = pd.Timedelta(minutes=cooldown_between_deals)

        has_entry_conditions = bool(entry_conditions)
        has_exit_conditions = conditions_active and bool(exit_conditions)

        active_trades = {}
        last_close_time = {}
        last_row_by_symbol = {}
        trade_events = deque()
        trade_ID_counter = 0
        global_active_deals = 0

        def record_trade(action, row, trade_price, quantity, amount, total_amount,
                         profit_percent, move_from_entry, trade_id, comment=""):
            event = {
                "timestamp": row["timestamp"],
                "symbol": row["symbol"],
                "action": action,
                "price": trade_price,
                "quantity": quantity,
                "amount": amount,
                "total_amount": total_amount,
                "move_from_entry": move_from_entry,
                "profit_percent": profit_percent,
                "trade_comment": comment,
                "trade_id": trade_id,
            }
            trade_events.append(event)

        balance = initial_balance
        real_balance = initial_balance
        free_cash = initial_balance
        positions_by_symbol = defaultdict(float)
        last_close = defaultdict(float)
        max_balance_so_far = initial_balance
        max_drawdown_so_far = 0.0

        for idx, row in all_df.iterrows():
            current_time = row["timestamp"]
            sym = row["symbol"]
            close_px = row["close"]

            if sym in last_close_time and (current_time - last_close_time[sym]) < cooldown_delta:
                last_row_by_symbol[sym] = row
                continue

            prev_row = last_row_by_symbol.get(sym, None)
            last_row_by_symbol[sym] = row
            last_close[sym] = close_px

            # Check for exits first
            if sym in active_trades and active_trades[sym] is not None:
                trade = active_trades[sym]
                move_from_entry = (close_px - trade["entry_price"]) / trade["entry_price"] if trade["entry_price"] > 1e-12 else 0.0

                # Stop loss
                if stop_loss_toggle and trade.get("stop_loss_threshold") and close_px <= trade["stop_loss_threshold"]:
                    qty2sell = trade["quantity"]
                    amount_sl = close_px * qty2sell
                    profit_percent = (amount_sl - trade["total_amount"]) / trade["total_amount"] if trade["total_amount"] > 0 else 0.0
                    record_trade("Stop Loss EXIT", row, close_px, qty2sell, amount_sl,
                                 trade["total_amount"], profit_percent, move_from_entry,
                                 trade["trade_id"], f"Stop loss at {stop_loss_value}%")
                    active_trades[sym] = None
                    global_active_deals -= 1
                    last_close_time[sym] = current_time
                    profit_loss = amount_sl * (1 - trading_fee) - trade["total_amount"]
                    free_cash += amount_sl * (1 - trading_fee)
                    positions_by_symbol[sym] -= qty2sell
                    real_balance += profit_loss
                    continue

                # Take profit
                if price_change_active and trade.get("take_profit_threshold") and close_px >= trade["take_profit_threshold"]:
                    qty2sell = trade["quantity"]
                    amount_tp = close_px * qty2sell
                    profit_percent = (amount_tp - trade["total_amount"]) / trade["total_amount"] if trade["total_amount"] > 0 else 0.0
                    record_trade("Take Profit EXIT", row, close_px, qty2sell, amount_tp,
                                 trade["total_amount"], profit_percent, move_from_entry,
                                 trade["trade_id"], f"Take profit at {target_profit}%")
                    active_trades[sym] = None
                    global_active_deals -= 1
                    last_close_time[sym] = current_time
                    profit_loss = amount_tp * (1 - trading_fee) - trade["total_amount"]
                    free_cash += amount_tp * (1 - trading_fee)
                    positions_by_symbol[sym] -= qty2sell
                    real_balance += profit_loss
                    continue

                # Exit conditions
                if has_exit_conditions and check_all_user_conditions(row.to_dict(), exit_conditions, prev_row.to_dict() if prev_row is not None else None):
                    qty2sell = trade["quantity"]
                    amount_exit = close_px * qty2sell
                    profit_percent = (amount_exit - trade["total_amount"]) / trade["total_amount"] if trade["total_amount"] > 0 else 0.0
                    if not minprof_toggle or profit_percent >= minimal_profit:
                        record_trade("SELL", row, close_px, qty2sell, amount_exit,
                                     trade["total_amount"], profit_percent, move_from_entry,
                                     trade["trade_id"], "Exit conditions met")
                        active_trades[sym] = None
                        global_active_deals -= 1
                        last_close_time[sym] = current_time
                        profit_loss = amount_exit * (1 - trading_fee) - trade["total_amount"]
                        free_cash += amount_exit * (1 - trading_fee)
                        positions_by_symbol[sym] -= qty2sell
                        real_balance += profit_loss
                        continue

            # Check for entries
            if sym not in active_trades or active_trades[sym] is None:
                if global_active_deals < max_active_deals:
                    if has_entry_conditions and check_all_user_conditions(row.to_dict(), entry_conditions, prev_row.to_dict() if prev_row is not None else None):
                        trade_ID_counter += 1
                        trade_id = f"{trade_ID_counter}-{sym}"
                        qty = base_order_size / close_px if close_px > 1e-12 else 0.0
                        amount = close_px * qty
                        
                        new_trade = {
                            "trade_id": trade_id,
                            "quantity": qty,
                            "entry_price": close_px,
                            "total_amount": amount,
                            "time_opened": current_time,
                            "stop_loss_threshold": close_px * (1.0 - sl_frac) if sl_frac > 0 else None,
                            "take_profit_threshold": close_px * (1.0 + tp_frac) if tp_frac > 0 else None,
                        }
                        active_trades[sym] = new_trade
                        global_active_deals += 1
                        record_trade("BUY", row, close_px, qty, amount, amount, "", 0.0, trade_id, "Entry conditions met")
                        free_cash -= amount * (1 + trading_fee)
                        positions_by_symbol[sym] += qty

            # Update unrealized balance
            unrealized_balance = free_cash
            for s, q in positions_by_symbol.items():
                unrealized_balance += (q * last_close[s]) * (1 - trading_fee)
            if unrealized_balance > max_balance_so_far:
                max_balance_so_far = unrealized_balance
            current_drawdown = 0.0
            if max_balance_so_far > 0:
                current_drawdown = (max_balance_so_far - unrealized_balance) / max_balance_so_far
            if current_drawdown > max_drawdown_so_far:
                max_drawdown_so_far = current_drawdown

        # Process trade events into output
        all_trades = list(trade_events)
        if not all_trades:
            return {
                "status": "success",
                "message": "No trades generated.",
                "metrics": {},
            }
            
        df_trades = pd.DataFrame(all_trades).sort_values("timestamp").reset_index(drop=True)

        # Build output records
        balance = initial_balance
        real_balance = initial_balance
        free_cash = initial_balance
        positions_by_symbol = defaultdict(float)
        last_close = defaultdict(float)
        trade_accum = {}
        out_records = []
        max_balance_so_far = initial_balance
        max_drawdown_so_far = 0.0

        def is_buy_or_entry(action_text):
            text = str(action_text).lower()
            return ("buy" in text) or ("safety" in text)

        def is_exit_action(action_text):
            text = str(action_text).lower()
            return ("sell" in text) or ("exit" in text)

        for row in df_trades.to_dict("records"):
            sym = row["symbol"]
            act = str(row["action"]).lower()
            tid = row.get("trade_id", "")
            px = float(row["price"])
            amt = float(row["amount"])

            last_close[sym] = px

            position = 0.0
            order_size = 0.0
            profit_loss = 0.0

            if tid not in trade_accum:
                trade_accum[tid] = {
                    "position": 0.0,
                    "trade_size": 0.0,
                }

            if is_buy_or_entry(act):
                order_size = amt
                position = order_size / px if px > 0 else 0.0
                positions_by_symbol[sym] += position
                free_cash -= (order_size * (1 + trading_fee))
                trade_accum[tid]["position"] += position
                trade_accum[tid]["trade_size"] += order_size
            elif is_exit_action(act):
                position = trade_accum[tid]["position"]
                order_size = position * px
                profit_loss = order_size * (1 - trading_fee) - trade_accum[tid]["trade_size"] * (1 + trading_fee)
                positions_by_symbol[sym] -= position
                free_cash += (order_size * (1 - trading_fee))
                real_balance += profit_loss
                trade_accum[tid]["position"] = 0.0
                trade_accum[tid]["trade_size"] = 0.0

            unrealized_balance = free_cash
            for s, q in positions_by_symbol.items():
                unrealized_balance += (q * last_close[s]) * (1 - trading_fee)
            if unrealized_balance > max_balance_so_far:
                max_balance_so_far = unrealized_balance
            current_drawdown = 0.0
            if max_balance_so_far > 0:
                current_drawdown = (max_balance_so_far - unrealized_balance) / max_balance_so_far
            if current_drawdown > max_drawdown_so_far:
                max_drawdown_so_far = current_drawdown

            out_rec = {
                "timestamp": row["timestamp"],
                "symbol": sym,
                "action": row["action"],
                "price": round(px, 4),
                "trade_comment": row.get("trade_comment", ""),
                "trade_id": tid,
                "position": round(trade_accum[tid]["position"], 4),
                "order_size": round(order_size, 2),
                "trade_size": round(trade_accum[tid]["trade_size"], 2),
                "profit_loss": round(profit_loss, 2),
                "balance": round(balance, 2),
                "real_balance": round(real_balance, 2),
                "free_cash": round(free_cash, 2),
                "position_held": round(positions_by_symbol[sym], 4),
                "unrealized_balance": round(unrealized_balance, 2),
                "drawdown": round(current_drawdown, 4),
                "max_drawdown": round(max_drawdown_so_far, 4),
            }
            out_records.append(out_rec)

        df_out = pd.DataFrame(out_records)

        BACKTEST_RESULTS_DIR = os.path.join(DATA_DIR, "backtest_results", strategy_name)
        os.makedirs(BACKTEST_RESULTS_DIR, exist_ok=True)

        result = compute_metrics(df_out, initial_balance, payload, BACKTEST_RESULTS_DIR)
        return result

    except Exception as e:
        print(f"Exception in run_backtest: {e}")
        import traceback
        traceback.print_exc()
        return {"status": "error", "message": str(e)}


if __name__ == "__main__":
    # Test with sample payload
    sample_payload = {
        "strategy_name": "test_stock_strategy",
        "pairs": ["AAPL", "MSFT"],
        "max_active_deals": 2,
        "initial_balance": 10000,
        "trading_fee": 0.1,
        "base_order_size": 1000,
        "start_date": "2024-01-01",
        "end_date": "2024-12-31",
        "entry_conditions": [
            {"indicator": "RSI", "subfields": {"Timeframe": "1h", "RSI Length": 14, "Condition": "Less Than", "Signal Value": 30}}
        ],
        "exit_conditions": [
            {"indicator": "RSI", "subfields": {"Timeframe": "1h", "RSI Length": 14, "Condition": "Greater Than", "Signal Value": 70}}
        ],
        "conditions_active": True,
    }
    result = run_backtest(sample_payload)
    print(json.dumps(result.get("metrics", {}), indent=2, default=str))

