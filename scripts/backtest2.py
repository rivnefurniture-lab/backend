import json
from datetime import datetime
import os
import pandas as pd
import numpy as np
from collections import defaultdict, deque
from concurrent.futures import as_completed, ThreadPoolExecutor

# Constants
DATA_DIR = "static"

ALL_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"]

TIMEFRAME_TO_MINUTES = {
    "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60,
    "2h": 120, "4h": 240, "1d": 1440
}

def get_tf_priority(tf: str) -> int:
    return TIMEFRAME_TO_MINUTES.get(tf, 1)

def get_highest_timeframe(conditions):
    highest_tf = "1m"
    for cond in conditions:
        subs = cond.get("subfields", {})
        tf = subs.get("Timeframe", "1m")
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
    required = {"timestamp", "open", "high", "low", "close", "volume"}
    tf_mapping = {
        "1m": "close", "5m": "close_5m", "15m": "close_15m",
        "1h": "close_1h", "4h": "close_4h", "1d": "close_1d"
    }

    def parse_one(cond):
        indicator = cond.get("indicator", "")
        subs = cond.get("subfields", {})
        tf = subs.get("Timeframe", "1m")
        cols = []

        if indicator == "RSI":
            length = subs.get("RSI Length", 14)
            col = f"RSI_{length}"
            if tf != "1m":
                col += f"_{tf}"
            cols.append(col)
        elif indicator == "MA":
            ma_type = subs.get("MA Type", "SMA")
            fast_ma = subs.get("Fast MA", 14)
            slow_ma = subs.get("Slow MA", 28)
            col_fast = f"{ma_type}_{fast_ma}"
            col_slow = f"{ma_type}_{slow_ma}"
            if tf != "1m":
                col_fast += f"_{tf}"
                col_slow += f"_{tf}"
            cols.extend([col_fast, col_slow])
        elif indicator == "BollingerBands":
            period = subs.get("BB% Period", 20)
            dev = subs.get("Deviation", 2)
            col = f"BB_%B_{period}_{dev}"
            if tf != "1m":
                col += f"_{tf}"
            cols.append(col)
        elif indicator == "MACD":
            preset = subs.get("MACD Preset", "12,26,9")
            fast_str, slow_str, sig_str = preset.split(',')
            main_col = f"MACD_{fast_str}_{slow_str}_{sig_str}"
            signal_col = f"MACD_{fast_str}_{slow_str}_{sig_str}_Signal"
            if tf != "1m":
                main_col += f"_{tf}"
                signal_col += f"_{tf}"
            cols.extend([main_col, signal_col])
        elif indicator == "Stochastic":
            stoch_preset = subs.get("Stochastic Preset", "14,3,3")
            k_str, ksmooth_str, dsmooth_str = stoch_preset.split(',')
            k_col = f"Stochastic_K_{k_str}_{ksmooth_str}"
            d_col = f"Stochastic_D_{k_str}_{ksmooth_str}_{dsmooth_str}"
            if tf != "1m":
                k_col += f"_{tf}"
                d_col += f"_{tf}"
            cols.extend([k_col, d_col])
        elif indicator == "ParabolicSAR":
            psar_str = subs.get("PSAR Preset", "0.02,0.2")
            step_str, max_str = psar_str.split(',')
            col = f"PSAR_AF_{step_str}_Max_{max_str}"
            if tf != "1m":
                col += f"_{tf}"
            cols.append(col)
        elif indicator == "TradingView":
            col = "tv_tech_label"
            if tf != "1m":
                col += f"_{tf}"
            cols.append(col)
        elif indicator == "HeikenAshi":
            col = "HA_Close"
            if tf != "1m":
                col += f"_{tf}"
            cols.append(col)
        else:
            cols = []

        cols.append(tf_mapping[tf])
        return cols, tf

    for cond in entry_conditions:
        cols, tf = parse_one(cond)
        for c in cols:
            required.add(c)
        if tf != "1m":
            required.add(f"close_{tf}")

    for cond in safety_conditions:
        cols, tf = parse_one(cond)
        for c in cols:
            required.add(c)
        if tf != "1m":
            required.add(f"close_{tf}")

    for cond in exit_conditions:
        cols, tf = parse_one(cond)
        for c in cols:
            required.add(c)
        if tf != "1m":
            required.add(f"close_{tf}")

    return list(required)

def load_parquets_in_parallel(pairs, required_cols):
    results = {}
    def load_one(pair):
        file_path = os.path.join(DATA_DIR, f'{pair.replace("/", "_")}_all_tf_merged.parquet')
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"Parquet file not found for {pair}: {file_path}")
        df = pd.read_parquet(file_path, columns=required_cols)
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
    if not conditions:
        return True

    for cond in conditions:
        indicator = cond.get("indicator", "")
        subs = cond.get("subfields", {})
        tf = subs.get("Timeframe", "1m")
        tf_mapping = {
            '1m': 'close', '5m': 'close_5m', '15m': 'close_15m',
            '1h': 'close_1h', '4h': 'close_4h', '1d': 'close_1d'
        }
        if not row[tf_mapping[tf]]:
            return False

        operator = subs.get("Condition", "")
        value = subs.get("Signal Value", None)

        if indicator == "RSI":
            length = subs.get("RSI Length", 14)
            col = f"RSI_{length}"
            if tf != "1m":
                col += f"_{tf}"
            row_val = row.get(col, None)
            if row_val is None:
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
            else:
                if isinstance(value, str):
                    if row_val != value:
                        return False
                else:
                    return False
        elif indicator == "TradingView":
            col = "tv_tech_label"
            if tf != "1m":
                col += f"_{tf}"
            row_val = row.get(col, None)
            if row_val is None:
                return False
            synonyms = {
                "Buy": {"Buy", "Strong Buy"},
                "Strong Buy": {"Strong Buy"},
                "Sell": {"Sell", "Strong Sell"},
                "Strong Sell": {"Strong Sell"},
                "Neutral": {"Neutral"}
            }
            desired_set = synonyms.get(value, {value})
            if row_val not in desired_set:
                return False
        elif indicator == "HeikenAshi":
            col = "HA_Close"
            if tf != "1m":
                col += f"_{tf}"
            row_val = row.get(col, None)
            if row_val is None:
                return False
            if operator == "Greater Than":
                if value is None or not (row_val > value):
                    return False
            elif operator == "Less Than":
                if value is None or not (row_val < value):
                    return False
        elif indicator == "MA":
            ma_type = subs.get("MA Type", "SMA")
            fast_ma = subs.get("Fast MA", 14)
            slow_ma = subs.get("Slow MA", 28)
            col_fast = f"{ma_type}_{fast_ma}"
            col_slow = f"{ma_type}_{slow_ma}"
            if tf != "1m":
                col_fast += f"_{tf}"
                col_slow += f"_{tf}"
            val_fast = row.get(col_fast, None)
            val_slow = row.get(col_slow, None)
            if val_fast is None or val_slow is None:
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
            else:
                return False
        elif indicator == "BollingerBands":
            period = subs.get("BB% Period", 20)
            dev = subs.get("Deviation", 2)
            col = f"BB_%B_{period}_{dev}"
            if tf != "1m":
                col += f"_{tf}"
            row_val = row.get(col, None)
            if row_val is None:
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
            else:
                return False
        elif indicator == "MACD":
            macd_preset = subs.get("MACD Preset", "12,26,9")
            fast_str, slow_str, sig_str = macd_preset.split(',')
            main_name = f"MACD_{fast_str}_{slow_str}_{sig_str}"
            signal_name = f"MACD_{fast_str}_{slow_str}_{sig_str}_Signal"
            if tf != "1m":
                main_name += f"_{tf}"
                signal_name += f"_{tf}"
            main_val = row.get(main_name, None)
            signal_val = row.get(signal_name, None)
            if main_val is None or signal_val is None:
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
            line_trigger = subs.get("Line Trigger", "")
            if line_trigger == "Less Than 0":
                if main_val >= 0:
                    return False
            elif line_trigger == "Greater Than 0":
                if main_val <= 0:
                    return False
        elif indicator == "Stochastic":
            stoch_preset = subs.get("Stochastic Preset", "14,3,3")
            k_str, ksmooth_str, dsmooth_str = stoch_preset.split(',')
            k_col = f"Stochastic_K_{k_str}_{ksmooth_str}"
            d_col = f"Stochastic_D_{k_str}_{ksmooth_str}_{dsmooth_str}"
            if tf != "1m":
                k_col += f"_{tf}"
                d_col += f"_{tf}"
            k_val = row.get(k_col, None)
            d_val = row.get(d_col, None)
            if k_val is None:
                return False
            k_cond = subs.get("K Condition", "")
            k_sig_val = subs.get("K Signal Value", None)
            if k_cond == "Less Than":
                if k_sig_val is None or not (k_val < k_sig_val):
                    return False
            elif k_cond == "Greater Than":
                if k_sig_val is None or not (k_val > k_sig_val):
                    return False
            elif k_cond == "Crossing Down":
                if prev_row is None or k_sig_val is None:
                    return False
                prev_k = prev_row.get(k_col, None)
                if prev_k is None or not (prev_k >= k_sig_val and k_val < k_sig_val):
                    return False
            elif k_cond == "Crossing Up":
                if prev_row is None or k_sig_val is None:
                    return False
                prev_k = prev_row.get(k_col, None)
                if prev_k is None or not (prev_k <= k_sig_val and k_val > k_sig_val):
                    return False
            main_condition = subs.get("Condition", "")
            if main_condition == "K Crossing Up D":
                if prev_row is None or d_val is None:
                    return False
                prev_k = prev_row.get(k_col, None)
                prev_d = prev_row.get(d_col, None)
                if prev_k is None or prev_d is None or not (prev_k <= prev_d and k_val > d_val):
                    return False
            elif main_condition == "K Crossing Down D":
                if prev_row is None or d_val is None:
                    return False
                prev_k = prev_row.get(k_col, None)
                prev_d = prev_row.get(d_col, None)
                if prev_k is None or prev_d is None or not (prev_k >= prev_d and k_val < d_val):
                    return False
        elif indicator == "ParabolicSAR":
            psar_str = subs.get("PSAR Preset", "0.02,0.2")
            step_str, max_str = psar_str.split(',')
            col = f"PSAR_AF_{step_str}_Max_{max_str}"
            if tf != "1m":
                col += f"_{tf}"
            row_val = row.get(col, None)
            if row_val is None:
                return False
            if operator in ["Crossing (Long)", "Crossing (Short)"]:
                if prev_row is None:
                    return False
                prev_val = prev_row.get(col, None)
                if prev_val is None:
                    return False
                close_now = row.get('close', None)
                close_prev = prev_row.get('close', None)
                if close_now is None or close_prev is None:
                    return False
                if operator == "Crossing (Long)":
                    if not (close_prev <= prev_val and close_now > row_val):
                        return False
                elif operator == "Crossing (Short)":
                    if not (close_prev >= prev_val and close_now < row_val):
                        return False
            else:
                if operator == "Less Than":
                    if value is None or not (row_val < value):
                        return False
                elif operator == "Greater Than":
                    if value is None or not (row_val > value):
                        return False
                else:
                    return False
        else:
            return False
    return True

def compute_metrics(df_out, initial_balance, payload, BACKTEST_RESULTS_DIR, DATA_DIR):
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

    deal_durations = []
    open_time = {}
    for i, row in df_out.iterrows():
        t_id = row["trade_id"]
        action_lc = str(row["action"]).lower()
        ts = row["timestamp"]
        if "buy" in action_lc or "safety" in action_lc:
            if t_id not in open_time:
                open_time[t_id] = ts
        elif "sell" in action_lc or "exit" in action_lc:
            if t_id in open_time:
                duration = ts - open_time[t_id]
                deal_durations.append(duration)
                del open_time[t_id]

    if len(deal_durations) == 0:
        max_deal_duration = "0 days"
        avg_deal_duration = "0 days"
    else:
        max_dur = max(deal_durations)
        avg_dur = sum(deal_durations, pd.Timedelta(0)) / len(deal_durations)
        def fmt_td(td):
            secs = int(td.total_seconds())
            days, secs = divmod(secs, 86400)
            hours, secs = divmod(secs, 3600)
            minutes, secs = divmod(secs, 60)
            out = f"{days} days, {hours} hours, {minutes} minutes"
            return out
        max_deal_duration = fmt_td(max_dur)
        avg_deal_duration = fmt_td(avg_dur)

    total_years = total_minutes / 525600.0
    if total_years > 0:
        yearly_return = (1 + net_profit) ** (1 / total_years) - 1
    else:
        yearly_return = 0.0

    gross_profit = 0.0
    gross_loss = 0.0
    if "profit_loss" in df_out.columns:
        for i, row2 in df_out.iterrows():
            act_lc = str(row2["action"]).lower()
            pl = row2["profit_loss"]
            if (("sell" in act_lc) or ("exit" in act_lc)) and (pl != 0):
                if pl > 0:
                    gross_profit += pl
                else:
                    gross_loss += abs(pl)
    if gross_loss > 0:
        profit_factor = gross_profit / gross_loss
    else:
        profit_factor = "Infinity" if gross_profit > 0 else 1.0

    daily_bal = df_out.resample("1D", on="timestamp")["unrealized_balance"].last().ffill()
    daily_ret = daily_bal.pct_change().dropna()
    if len(daily_ret) > 1:
        sharpe_ratio = daily_ret.mean() / daily_ret.std() * np.sqrt(252)
    else:
        sharpe_ratio = 0.0

    neg_ret = daily_ret[daily_ret < 0]
    if len(neg_ret) > 0:
        downside_std = neg_ret.std()
        sortino_ratio = daily_ret.mean() / downside_std * np.sqrt(252)
    else:
        sortino_ratio = 0.0

    total_trades = 0
    wins = 0
    if "profit_loss" in df_out.columns:
        for i, row3 in df_out.iterrows():
            act_lc = str(row3["action"]).lower()
            pl = row3["profit_loss"]
            if ("sell" in act_lc) or ("exit" in act_lc):
                total_trades += 1
                if pl > 0:
                    wins += 1

    if total_trades > 0:
        win_rate = wins / total_trades
    else:
        win_rate = 0.0

    if total_trades > 0:
        avg_profit_per_trade = (gross_profit - gross_loss) / total_trades
    else:
        avg_profit_per_trade = 0.0

    num_wins = wins
    num_losses = total_trades - wins
    if num_wins > 0:
        avg_win_amt = gross_profit / num_wins
    else:
        avg_win_amt = 0.0
    if num_losses > 0:
        avg_loss_amt = gross_loss / num_losses
    else:
        avg_loss_amt = 1.0
    risk_reward_ratio = (avg_win_amt / avg_loss_amt) if avg_loss_amt > 0 else float("inf")

    in_position_minutes = 0.0
    for i in range(len(df_out) - 1):
        sumpos = df_out["position_held"].iloc[i]
        t1 = df_out["timestamp"].iloc[i]
        t2 = df_out["timestamp"].iloc[i + 1]
        delta = (t2 - t1).total_seconds() / 60.0
        if sumpos > 0:
            in_position_minutes += delta
    exposure_time_frac = 0.0
    if total_minutes > 0:
        exposure_time_frac = in_position_minutes / total_minutes

    var_95 = 0.0
    if len(daily_ret) > 0:
        var_95 = -daily_ret.quantile(0.05)

    metrics = {
        "net_profit": net_profit,
        "total_profit": total_profit,
        "net_profit_usd": f"${round(net_profit_usd,2)}",
        "total_profit_usd": f"${round(total_profit_usd,2)}",
        "average_daily_profit": average_daily_profit,
        "max_deal_duration": max_deal_duration,
        "avg_deal_duration": avg_deal_duration,
        "yearly_return": yearly_return,
        "profit_factor": profit_factor,
        "gross_profit": gross_profit,
        "gross_loss": gross_loss,
        "sharpe_ratio": sharpe_ratio,
        "sortino_ratio": sortino_ratio,
        "total_trades": total_trades,
        "win_rate": win_rate,
        "avg_profit_per_trade": avg_profit_per_trade,
        "risk_reward_ratio": risk_reward_ratio,
        "exposure_time_frac": exposure_time_frac,
        "var_95": var_95
    }

    if df_out.empty:
        return {"status": "error", "message": "No trade data available."}

    final_unreal_dd = df_out["max_drawdown"].iloc[-1]
    metrics["max_drawdown"] = final_unreal_dd

    if "max_realized_drawdown" in df_out.columns:
        final_real_dd = df_out["max_realized_drawdown"].iloc[-1]
        metrics["max_realized_drawdown"] = final_real_dd
    else:
        metrics["max_realized_drawdown"] = 0.0

    realized_losses = 0.0
    for i, row in df_out.iterrows():
        act = str(row["action"]).lower()
        pl = row.get("profit_loss", 0.0)
        if (("exit" in act) or ("sell" in act)) and (pl < 0):
            realized_losses += abs(pl)
    metrics["total_realized_loss"] = realized_losses

    print("Metrics:", metrics)

    summary_csv_path = os.path.join(BACKTEST_RESULTS_DIR, "backtest_summary_metrics.csv")
    summary_data = {
        "timestamp_run": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "strategy_name": payload.get("strategy_name", ""),
        "pairs": json.dumps(payload.get("pairs", [])),
        "initial_balance": initial_balance,
        "max_active_deals": payload.get("max_active_deals", 0),
        "trading_fee": payload.get("trading_fee", 0.0),
        "base_order_size": payload.get("base_order_size", 0.0),
        "start_date": payload.get("start_date", ""),
        "end_date": payload.get("end_date", ""),
        "max_drawdown": metrics["max_drawdown"],
        "max_realized_drawdown": metrics["max_realized_drawdown"],
        "total_realized_loss": metrics["total_realized_loss"],
        "entry_conditions": json.dumps(payload.get("entry_conditions", [])),
        "safety_order_toggle": payload.get("safety_order_toggle", False),
        "safety_order_size": payload.get("safety_order_size", 0.0),
        "price_deviation": payload.get("price_deviation", 0.0),
        "max_safety_orders_count": payload.get("max_safety_orders_count", 0),
        "safety_order_volume_scale": payload.get("safety_order_volume_scale", 0.0),
        "safety_order_step_scale": payload.get("safety_order_step_scale", 0.0),
        "safety_conditions": json.dumps(payload.get("safety_conditions", [])),
        "price_change_active": payload.get("price_change_active", False),
        "conditions_active": payload.get("conditions_active", False),
        "take_profit_type": payload.get("take_profit_type", ""),
        "target_profit": payload.get("target_profit", 0.0),
        "trailing_toggle": payload.get("trailing_toggle", False),
        "trailing_deviation": payload.get("trailing_deviation", 0.0),
        "exit_conditions": json.dumps(payload.get("exit_conditions", [])),
        "minprof_toggle": payload.get("minprof_toggle", False),
        "minimal_profit": payload.get("minimal_profit", 0),
        "reinvest_profit": payload.get("reinvest_profit", 0.0),
        "stop_loss_toggle": payload.get("stop_loss_toggle", False),
        "stop_loss_value": payload.get("stop_loss_value", 0.0),
        "stop_loss_timeout": payload.get("stop_loss_timeout", 0.0),
        "stop_loss_trailing": payload.get("stop_loss_trailing", False),
        "risk_reduction": payload.get("risk_reduction", 0.0),
        "min_daily_volume": payload.get("min_daily_volume", 0.0),
        "cooldown_between_deals": payload.get("cooldown_between_deals", 0),
        "close_deal_after_timeout": payload.get("close_deal_after_timeout", 0),
        "net_profit": metrics.get("net_profit", 0),
        "total_profit": metrics.get("total_profit", 0),
        "net_profit_usd": metrics.get("net_profit_usd", 0),
        "total_profit_usd": metrics.get("total_profit_usd", 0),
        "average_daily_profit": round(metrics.get("average_daily_profit", 0), 5),
        "max_deal_duration": metrics.get("max_deal_duration", ""),
        "avg_deal_duration": metrics.get("avg_deal_duration", ""),
        "yearly_return": round(metrics.get("yearly_return", 0), 2),
        "profit_factor": metrics.get("profit_factor", 0),
        "gross_loss": metrics.get("gross_loss", 0),
        "gross_profit": metrics.get("gross_profit", 0),
        "sharpe_ratio": round(metrics.get("sharpe_ratio", 0), 2),
        "sortino_ratio": round(metrics.get("sortino_ratio", 0), 2),
        "total_trades": metrics.get("total_trades", 0),
        "win_rate": round(metrics.get("win_rate", 0), 2),
        "avg_profit_per_trade": round(metrics.get("avg_profit_per_trade", 0), 2),
        "risk_reward_ratio": round(metrics.get("risk_reward_ratio", 0), 2),
        "exposure_time_frac": round(metrics.get("exposure_time_frac", 0), 2),
        "var_95": round(metrics.get("var_95", 0), 2),
    }
    df_summary = pd.DataFrame([summary_data])
    df_summary.to_csv(summary_csv_path, index=False)
    print(f"Wrote run summary to {summary_csv_path}")

    chart_data = {
        "timestamps": df_out["timestamp"].astype(str).tolist(),
        "unrealized_balance": df_out["unrealized_balance"].tolist(),
    }
    chart_data_realized = {
        "timestamps": df_out["timestamp"].astype(str).tolist(),
        "real_balance": df_out["real_balance"].tolist(),
        "realized_drawdown": df_out["realized_drawdown"].tolist()
    }

    start_ts = df_out["timestamp"].min()
    end_ts = df_out["timestamp"].max()
    target_sym = "BTC/USDT"
    file_path = os.path.join(DATA_DIR, f"{target_sym.replace('/','_')}_all_tf_merged.parquet")
    df_sym = pd.read_parquet(file_path, columns=["timestamp", "close"])
    df_sym["timestamp"] = pd.to_datetime(df_sym["timestamp"])
    df_sym.set_index("timestamp", inplace=True)
    df_sym = df_sym.resample("1min").ffill()
    df_sym_range = df_sym.loc[start_ts:end_ts].copy()

    if df_sym_range.empty:
        out_final = os.path.join(BACKTEST_RESULTS_DIR, "all_trades_combined.csv")
        df_out.to_csv(out_final, index=False)
        print(f"Final backtest => {out_final}")
        return {
            "status": "success",
            "message": "Backtest completed successfully (BTC/USDT data empty in range).",
            "metrics": metrics,
            "chartData": chart_data,
            "chart_data_realized": chart_data_realized
        }

    first_close = df_sym_range["close"].iloc[0]
    coins_held = initial_balance / first_close
    df_sym_range["bh_balance"] = df_sym_range["close"] * coins_held
    df_sym_range.reset_index(inplace=True)
    df_sym_range.set_index("timestamp", inplace=True)
    df_out.set_index("timestamp", inplace=True)
    df_out = df_out.join(df_sym_range["bh_balance"], how="left")
    df_out.reset_index(inplace=True)

    chart_data["bh_timestamps"] = df_sym_range.index.astype(str).tolist()
    chart_data["bh_balance"] = df_sym_range["bh_balance"].tolist()
    chart_data["drawdown"] = df_out["drawdown"].tolist()

    out_final = os.path.join(BACKTEST_RESULTS_DIR, "all_trades_combined.csv")
    df_out.to_csv(out_final, index=False)
    print(f"Final backtest => {out_final}")

    return {
        "status": "success",
        "message": "Backtest completed successfully.",
        "metrics": metrics,
        "chartData": chart_data,
        "chart_data_realized": chart_data_realized,
        "df_out": df_out
    }

def run_backtest(payload):
    try:
        payload = get_user_payload(payload)

        pairs = payload.get("pairs", [])
        pairs.sort()
        strategy_name = payload.get("strategy_name", '')
        max_active_deals = payload.get("max_active_deals", 0)
        initial_balance = payload.get("initial_balance", 10000.0)
        if not pairs:
            return {"status": "error", "message": "No pairs selected."}

        trading_fee = payload.get("trading_fee", 0.0) / 100
        base_order_size = payload.get("base_order_size", 0.0)
        safety_order_size = payload.get("safety_order_size", 0.0)
        risk_reduction = payload.get("risk_reduction", 0.0)
        reinvest_profit = payload.get("reinvest_profit", 0.0)
        close_deal_after_timeout = payload.get("close_deal_after_timeout", 0)

        req_cols = gather_required_columns(
            payload.get("entry_conditions", []),
            payload.get("safety_conditions", []),
            payload.get("exit_conditions", [])
        )
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
            df["day"] = df["timestamp"].dt.floor("D")
            df["volume_in_usdt"] = df["volume"] * df["close"]
            daily_vol = df.groupby("day")["volume_in_usdt"].sum().rename("daily_vol_usdt")
            df = df.merge(daily_vol, on="day", how="left")
            df["symbol"] = sym
            dfs_map[sym] = df

        all_df = pd.concat([df for df in dfs_map.values() if not df.empty], ignore_index=True)
        if all_df.empty:
            return {"status": "success", "message": "No data after filtering dates."}
        all_df.sort_values("timestamp", inplace=True)
        all_df.reset_index(drop=True, inplace=True)

        total_period = (end_date - start_date).total_seconds() if start_date and end_date else 0
        quarter_time = start_date + pd.Timedelta(seconds=total_period / 4) if total_period > 0 else None
        third_time = start_date + pd.Timedelta(seconds=total_period / 3) if total_period > 0 else None
        halfway_time = start_date + pd.Timedelta(seconds=total_period / 2) if total_period > 0 else None
        twothirds_time = start_date + pd.Timedelta(seconds=total_period / 1.5) if total_period > 0 else None
        almost_time = start_date + pd.Timedelta(seconds=total_period / 1.25) if total_period > 0 else None

        entry_conditions = payload.get("entry_conditions", [])
        exit_conditions = payload.get("exit_conditions", [])
        safety_conditions = payload.get("safety_conditions", [])
        safety_order_toggle = payload.get("safety_order_toggle", False)
        price_deviation = payload.get("price_deviation", 1.0)
        max_safety_orders = payload.get("max_safety_orders_count", 0)
        safety_step_scale = payload.get("safety_order_step_scale", 1.0)
        safety_vol_scale = payload.get("safety_order_volume_scale", 1.0)
        stop_loss_toggle = payload.get("stop_loss_toggle", False)
        stop_loss_value = payload.get("stop_loss_value", 0.0)
        price_change_active = payload.get("price_change_active", False)
        target_profit = payload.get("target_profit", 0.0)
        take_profit_type = payload.get("take_profit_type", "percentage-total")
        conditions_active = payload.get("conditions_active", False)
        minprof_toggle = payload.get("minprof_toggle", False)
        minimal_profit = payload.get("minimal_profit", 0) / 100
        min_daily_volume = payload.get("min_daily_volume", 0.0)
        cooldown_between_deals = payload.get("cooldown_between_deals", 0)
        stop_loss_timeout = payload.get("stop_loss_timeout", 0)

        dev_frac = price_deviation / 100.0 if safety_order_toggle and max_safety_orders > 0 else 0
        sl_frac = stop_loss_value / 100.0 if stop_loss_toggle and stop_loss_value > 0 else 0
        tp_frac = target_profit / 100.0 if target_profit > 0 else 0
        cooldown_delta = pd.Timedelta(minutes=cooldown_between_deals)
        stop_loss_delta = pd.Timedelta(minutes=stop_loss_timeout)

        entry_tf = get_highest_timeframe(entry_conditions) if entry_conditions else "1m"
        so_tf = get_highest_timeframe(safety_conditions) if safety_conditions else "1m"
        exit_tf = get_highest_timeframe(exit_conditions) if exit_conditions else "1m"

        has_entry_conditions = bool(entry_conditions)
        has_exit_conditions = conditions_active and bool(exit_conditions)
        has_safety_conditions = safety_order_toggle and bool(safety_conditions)

        active_trades = {}
        last_close_time = {}
        last_row_by_symbol = {}
        trade_events = deque()
        trade_ID_counter = 0
        global_active_deals = 0
        last_hour_check_ts = {}

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
            if req_cols:
                for c in req_cols:
                    event[c] = row.get(c, None)
            trade_events.append(event)

        current_candidates = []
        last_processed_time = None
        balance = initial_balance
        real_balance = initial_balance
        free_cash = initial_balance
        positions_by_symbol = defaultdict(float)
        last_close = defaultdict(float)
        max_balance_so_far = initial_balance
        max_drawdown_so_far = 0.0
        max_real_balance_so_far = initial_balance
        max_real_drawdown_so_far = 0.0
        early_stop_reason = None

        for idx, row in all_df.iterrows():
            current_time = row["timestamp"]
            sym = row["symbol"]
            close_px = row["close"]

            if row["daily_vol_usdt"] < min_daily_volume:
                continue

            if sym in last_close_time and (current_time - last_close_time[sym]) < cooldown_delta:
                last_row_by_symbol[sym] = row
                continue

            prev_row = last_row_by_symbol.get(sym, None)
            last_row_by_symbol[sym] = row
            last_close[sym] = close_px

            if last_processed_time is not None and current_time != last_processed_time:
                if current_candidates:
                    current_candidates.sort(key=lambda x: x["close"])
                    available_slots = max_active_deals - global_active_deals
                    selected_candidates = current_candidates[:available_slots] if available_slots > 0 else []
                    for candidate in selected_candidates:
                        candidate_sym = candidate["symbol"]
                        entry_close_px = candidate["close"] if entry_tf == "1m" else candidate.get(f"close_{entry_tf}")
                        trade_ID_counter += 1
                        trade_id = f"{trade_ID_counter}-{candidate_sym}"
                        qty = base_order_size / entry_close_px if entry_close_px > 1e-12 else 0.0
                        amount = entry_close_px * qty
                        total_amount = amount
                        new_trade = {
                            "trade_id": trade_id,
                            "quantity": qty,
                            "initial_quantity": qty,
                            "placed_so_count": 0,
                            "last_so_price": entry_close_px,
                            "last_so_size": safety_order_size,
                            "so_dev_factor": price_deviation,
                            "partial_tp_track": [],
                            "entry_price": entry_close_px,
                            "total_amount": total_amount,
                            "profit_percent": "",
                            "time_opened": current_time,
                            "next_so_price": entry_close_px * (1.0 - dev_frac) if safety_order_toggle and max_safety_orders > 0 else None,
                            "stop_loss_threshold": entry_close_px * (1.0 - sl_frac) if stop_loss_toggle and stop_loss_value > 0 else None,
                            "take_profit_threshold": entry_close_px * (1.0 + tp_frac) if target_profit > 0 else None
                        }
                        active_trades[candidate_sym] = new_trade
                        global_active_deals += 1
                        record_trade("BUY", candidate, entry_close_px, qty, amount, total_amount, "",
                                     0.0, trade_id, "Condition-based Entry")
                        free_cash -= amount * (1 + trading_fee)
                        positions_by_symbol[candidate_sym] += qty
                    current_candidates = []
                last_processed_time = current_time

            if sym not in active_trades or active_trades[sym] is None:
                entry_close_px = row["close"]
                if entry_close_px is None:
                    continue
                if has_entry_conditions and check_all_user_conditions(row, entry_conditions, prev_row):
                    current_candidates.append(row.copy())
            else:
                trade = active_trades[sym]
                move_from_entry = (close_px - trade["entry_price"]) / trade["entry_price"] if trade["entry_price"] > 1e-12 else 0.0

                if stop_loss_toggle and trade["stop_loss_threshold"] is not None:
                    time_since_open = current_time - trade["time_opened"]
                    if time_since_open >= stop_loss_delta and close_px <= trade["stop_loss_threshold"]:
                        qty2sell = trade["quantity"]
                        stop_px = close_px
                        amount_sl = stop_px * qty2sell
                        profit_percent = (amount_sl - trade["total_amount"]) / trade["total_amount"] if trade["total_amount"] > 0 else 0.0
                        record_trade("Stop Loss EXIT", row, stop_px, qty2sell, amount_sl,
                                     trade["total_amount"], profit_percent, move_from_entry,
                                     trade["trade_id"], f"Stop loss triggered at {stop_loss_value}%")
                        active_trades[sym] = None
                        global_active_deals -= 1
                        last_close_time[sym] = current_time
                        profit_loss = amount_sl * (1 - trading_fee) - trade["total_amount"]
                        free_cash += amount_sl * (1 - trading_fee)
                        positions_by_symbol[sym] -= qty2sell
                        real_balance += profit_loss
                        if profit_loss < 0:
                            balance += profit_loss * (risk_reduction / 100.0)
                        elif profit_loss > 0:
                            balance += profit_loss * (reinvest_profit / 100.0)
                        continue

                if close_deal_after_timeout > 0:
                    if current_time - trade["time_opened"] >= pd.Timedelta(minutes=close_deal_after_timeout):
                        qty2sell = trade["quantity"]
                        exit_px = close_px
                        amount_exit = exit_px * qty2sell
                        profit_percent = (amount_exit - trade["total_amount"]) / trade["total_amount"] if trade["total_amount"] > 0 else 0.0
                        record_trade("Timeout EXIT", row, exit_px, qty2sell, amount_exit,
                                     trade["total_amount"], profit_percent, move_from_entry,
                                     trade["trade_id"], f"Deal closed after timeout of {close_deal_after_timeout} minutes")
                        active_trades[sym] = None
                        global_active_deals -= 1
                        last_close_time[sym] = current_time
                        profit_loss = amount_exit * (1 - trading_fee) - trade["total_amount"]
                        free_cash += amount_exit * (1 - trading_fee)
                        positions_by_symbol[sym] -= qty2sell
                        real_balance += profit_loss
                        if profit_loss < 0:
                            balance += profit_loss * (risk_reduction / 100.0)
                        elif profit_loss > 0:
                            balance += profit_loss * (reinvest_profit / 100.0)
                        continue

                if has_exit_conditions and check_all_user_conditions(row, exit_conditions, prev_row):
                    exit_close_px = row["close"]
                    if exit_close_px is None:
                        continue
                    qty2sell = trade["quantity"]
                    amount_exit = exit_close_px * qty2sell
                    profit_percent = (amount_exit - trade["total_amount"]) / trade["total_amount"] if trade["total_amount"] > 0 else 0.0
                    if not minprof_toggle or profit_percent >= minimal_profit:
                        record_trade("SELL", row, exit_close_px, qty2sell, amount_exit,
                                     trade["total_amount"], profit_percent, move_from_entry,
                                     trade["trade_id"], "Exit triggered by conditions" + (" + min profit" if minprof_toggle else ""))
                        active_trades[sym] = None
                        global_active_deals -= 1
                        last_close_time[sym] = current_time
                        profit_loss = amount_exit * (1 - trading_fee) - trade["total_amount"]
                        free_cash += amount_exit * (1 - trading_fee)
                        positions_by_symbol[sym] -= qty2sell
                        real_balance += profit_loss
                        if profit_loss < 0:
                            balance += profit_loss * (risk_reduction / 100.0)
                        elif profit_loss > 0:
                            balance += profit_loss * (reinvest_profit / 100.0)
                        continue

                if sym in active_trades and active_trades[sym] is not None:
                    if sym not in last_hour_check_ts:
                        last_hour_check_ts[sym] = current_time
                    else:
                        hours_since = (current_time - last_hour_check_ts[sym]).total_seconds() / 3600.0
                        if hours_since >= 1.0:
                            record_trade("HOUR CHECK", row, close_px, 0.0, 0.0, 0.0, 0.0, 0.0, "", "Hourly checkpoint")
                            last_hour_check_ts[sym] = current_time

                if price_change_active and trade["take_profit_threshold"] is not None and close_px >= trade["take_profit_threshold"]:
                    qty2sell = trade["quantity"]
                    amount_tp = trade["take_profit_threshold"] * qty2sell
                    profit_percent = (amount_tp - trade["total_amount"]) / trade["total_amount"] if trade["total_amount"] > 0 else 0.0
                    record_trade("Take Profit EXIT", row, trade["take_profit_threshold"], qty2sell, amount_tp,
                                 trade["total_amount"], profit_percent, move_from_entry,
                                 trade["trade_id"], f"Take profit triggered at {target_profit}%")
                    active_trades[sym] = None
                    global_active_deals -= 1
                    last_close_time[sym] = current_time
                    profit_loss = amount_tp * (1 - trading_fee) - trade["total_amount"]
                    free_cash += amount_tp * (1 - trading_fee)
                    positions_by_symbol[sym] -= qty2sell
                    real_balance += profit_loss
                    if profit_loss < 0:
                        balance += profit_loss * (risk_reduction / 100.0)
                    elif profit_loss > 0:
                        balance += profit_loss * (reinvest_profit / 100.0)
                    continue

                if safety_order_toggle and trade["placed_so_count"] < max_safety_orders:
                    so_close_px = row["close"] if so_tf == "1m" else row.get(f"close_{so_tf}")
                    if so_close_px is None:
                        continue
                    if (not has_safety_conditions) or check_all_user_conditions(row, safety_conditions, prev_row):
                        orders_remaining = max_safety_orders - trade["placed_so_count"]
                        temp_next = trade["next_so_price"]
                        temp_dev = trade["so_dev_factor"]
                        orders_to_trigger = 0
                        for _ in range(orders_remaining):
                            if so_close_px < temp_next:
                                orders_to_trigger += 1
                                temp_dev *= safety_step_scale
                                temp_next *= (1.0 - (price_deviation * temp_dev) / 100.0)
                            else:
                                break
                        if orders_to_trigger > 0:
                            so_size = trade["last_so_size"]
                            for _ in range(orders_to_trigger):
                                so_qty = so_size / so_close_px if so_close_px > 1e-12 else 0.0
                                trade["placed_so_count"] += 1
                                trade["quantity"] += so_qty
                                order_amount = so_close_px * so_qty
                                trade["total_amount"] += order_amount
                                move_from_entry = (so_close_px - trade["entry_price"]) / trade["entry_price"] if trade["entry_price"] > 1e-12 else 0.0
                                if take_profit_type == "percentage-total" and trade["quantity"] > 0:
                                    avg_price = trade["total_amount"] / trade["quantity"]
                                    trade["take_profit_threshold"] = avg_price * (1.0 + tp_frac)
                                so_num = trade["placed_so_count"]
                                record_trade(f"Safety Order #{so_num}", row, so_close_px, so_qty, order_amount,
                                             trade["total_amount"], "", move_from_entry,
                                             trade["trade_id"], f"Added safety order #{so_num}")
                                trade["last_so_price"] = so_close_px
                                trade["so_dev_factor"] *= safety_step_scale
                                trade["next_so_price"] = trade["last_so_price"] * (1.0 - (price_deviation * trade["so_dev_factor"]) / 100.0)
                                so_size *= safety_vol_scale
                                free_cash -= order_amount * (1 + trading_fee)
                                positions_by_symbol[sym] += so_qty
                            trade["last_so_size"] = so_size

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

            if real_balance > max_real_balance_so_far:
                max_real_balance_so_far = real_balance
            current_realized_dd = 0.0
            if max_real_balance_so_far > 0:
                current_realized_dd = (max_real_balance_so_far - real_balance) / max_real_balance_so_far
            if current_realized_dd > max_real_drawdown_so_far:
                max_real_drawdown_so_far = current_realized_dd

            # DISABLED: Early stopping logic (to get full backtest results)
            # if max_drawdown_so_far >= 0.5:
            #     early_stop_reason = f"Stopped early due to max drawdown ≥ 30% at {current_time}"
            #     print(early_stop_reason)
            #     break
            pass

            if last_processed_time is None:
                last_processed_time = current_time

        if current_candidates and not early_stop_reason:
            current_candidates.sort(key=lambda x: x["close"])
            available_slots = max_active_deals - global_active_deals
            selected_candidates = current_candidates[:available_slots] if available_slots > 0 else []
            for candidate in selected_candidates:
                candidate_sym = candidate["symbol"]
                entry_close_px = candidate["close"] if entry_tf == "1m" else candidate.get(f"close_{entry_tf}")
                trade_ID_counter += 1
                trade_id = f"{trade_ID_counter}-{candidate_sym}"
                qty = base_order_size / entry_close_px if entry_close_px > 1e-12 else 0.0
                amount = entry_close_px * qty
                total_amount = amount
                new_trade = {
                    "trade_id": trade_id,
                    "quantity": qty,
                    "initial_quantity": qty,
                    "placed_so_count": 0,
                    "last_so_price": entry_close_px,
                    "last_so_size": safety_order_size,
                    "so_dev_factor": price_deviation,
                    "partial_tp_track": [],
                    "entry_price": entry_close_px,
                    "total_amount": total_amount,
                    "profit_percent": "",
                    "time_opened": current_time,
                    "next_so_price": entry_close_px * (1.0 - dev_frac) if safety_order_toggle and max_safety_orders > 0 else None,
                    "stop_loss_threshold": entry_close_px * (1.0 - sl_frac) if stop_loss_toggle and stop_loss_value > 0 else None,
                    "take_profit_threshold": entry_close_px * (1.0 + tp_frac) if target_profit > 0 else None
                }
                active_trades[candidate_sym] = new_trade
                global_active_deals += 1
                record_trade("BUY", candidate, entry_close_px, qty, amount, total_amount, "",
                             0.0, trade_id, "Condition-based Entry")
                free_cash -= amount * (1 + trading_fee)
                positions_by_symbol[candidate_sym] += qty

        all_trades = list(trade_events)
        if not all_trades:
            BACKTEST_RESULTS_DIR = os.path.join(DATA_DIR, "backtest_results", strategy_name)
            os.makedirs(BACKTEST_RESULTS_DIR, exist_ok=True)
            return {
                "status": "success",
                "message": "No trades generated => cannot display metrics.",
                "results_directory": BACKTEST_RESULTS_DIR
            }
        df_trades = pd.DataFrame(all_trades).sort_values(["timestamp", "symbol"]).reset_index(drop=True)

        active_deals_count = 0
        active_trade_id = {p: None for p in pairs}
        skipped_trade_ids = set()

        def is_buy_or_entry(action_text):
            text = str(action_text).lower()
            return ("buy" in text) or ("safety" in text)

        def is_exit_action(action_text):
            text = str(action_text).lower()
            return ("sell" in text) or ("exit" in text)

        def is_hour_check(a):
            return str(a).lower() == "hour check"

        filtered_rows = []
        for _, row in df_trades.iterrows():
            t_id = row.get("trade_id", "")
            sym = row["symbol"]
            act = row["action"]
            if is_hour_check(act):
                filtered_rows.append(row)
                continue
            if t_id in skipped_trade_ids:
                continue
            if is_buy_or_entry(act):
                if active_trade_id[sym] is None:
                    if active_deals_count < max_active_deals:
                        active_trade_id[sym] = t_id
                        active_deals_count += 1
                        filtered_rows.append(row)
                    else:
                        skipped_trade_ids.add(t_id)
                else:
                    if t_id == active_trade_id[sym]:
                        filtered_rows.append(row)
                    else:
                        skipped_trade_ids.add(t_id)
            elif is_exit_action(act):
                if active_trade_id[sym] is not None and t_id == active_trade_id[sym]:
                    active_trade_id[sym] = None
                    active_deals_count -= 1
                    filtered_rows.append(row)
                else:
                    filtered_rows.append(row)
        if not filtered_rows:
            BACKTEST_RESULTS_DIR = os.path.join(DATA_DIR, "backtest_results", strategy_name)
            os.makedirs(BACKTEST_RESULTS_DIR, exist_ok=True)
            return {
                "status": "success",
                "message": "All trades were skipped => no final CSV => no metrics.",
                "results_directory": BACKTEST_RESULTS_DIR
            }
        df_filtered = pd.DataFrame(filtered_rows).sort_values("timestamp").reset_index(drop=True)

        balance = initial_balance
        real_balance = initial_balance
        free_cash = initial_balance
        positions_by_symbol = defaultdict(float)
        last_close = defaultdict(float)
        trade_accum = {}
        out_records = []
        max_balance_so_far = initial_balance
        max_drawdown_so_far = 0.0
        max_real_balance_so_far = initial_balance
        max_real_drawdown_so_far = 0.0
        early_stop_reason = None

        for row in df_filtered.to_dict("records"):
            sym = row["symbol"]
            act = str(row["action"]).lower()
            tid = row.get("trade_id", "")
            px = float(row["price"])
            amt = float(row["amount"])
            tot = float(row["total_amount"])
            ppct_val = row.get("profit_percent", "")
            ppct = float(ppct_val) if ppct_val != "" else 0.0
            current_time = row["timestamp"]

            last_close[sym] = px

            position = 0.0
            order_size = 0.0
            profit_loss = 0.0
            position_change = 0.0

            if tid not in trade_accum:
                trade_accum[tid] = {
                    "position": 0.0,
                    "trade_size": 0.0,
                    "fraction": (real_balance / initial_balance) if initial_balance else 0.0
                }

            if is_buy_or_entry(act):
                fraction = trade_accum[tid]["fraction"]
                order_size = fraction * amt
                position = order_size / px if px > 0 else 0.0
                positions_by_symbol[sym] += position
                position_change = position
                free_cash -= (order_size * (1 + trading_fee))
                trade_accum[tid]["position"] += position
                trade_accum[tid]["trade_size"] += order_size
            elif is_exit_action(act):
                position = trade_accum[tid]["position"]
                order_size = position * px
                profit_loss = order_size * (1 - trading_fee) - trade_accum[tid]["trade_size"] * (1 + trading_fee)
                positions_by_symbol[sym] -= position
                position_change = -position
                free_cash += (order_size * (1 - trading_fee))
                if profit_loss < 0:
                    balance += (profit_loss * (risk_reduction / 100.0))
                elif profit_loss > 0:
                    balance += (profit_loss * (reinvest_profit / 100.0))
                trade_accum[tid]["position"] = 0.0
                trade_accum[tid]["trade_size"] = 0.0
                real_balance += profit_loss - order_size * trading_fee

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

            if real_balance > max_real_balance_so_far:
                max_real_balance_so_far = real_balance
            current_realized_dd = 0.0
            if max_real_balance_so_far > 0:
                current_realized_dd = (max_real_balance_so_far - real_balance) / max_real_balance_so_far
            if current_realized_dd > max_real_drawdown_so_far:
                max_real_drawdown_so_far = current_realized_dd

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
                "position_change": round(position_change, 4),
                "position_held": round(positions_by_symbol[sym], 4),
                "unrealized_balance": round(unrealized_balance, 2),
                "drawdown": round(current_drawdown, 4),
                "max_drawdown": round(max_drawdown_so_far, 4),
                "realized_drawdown": round(current_realized_dd, 4),
                "max_realized_drawdown": round(max_real_drawdown_so_far, 4),
            }
            out_records.append(out_rec)

            # DISABLED: Early stopping logic in second pass (to get full backtest results)
            # if max_drawdown_so_far >= 0.3:
            #     early_stop_reason = f"Stopped early due to max drawdown ≥ 30% at {current_time}"
            #     print(early_stop_reason)
            #     break
            pass

        df_out = pd.DataFrame(out_records, columns=[
            "timestamp", "symbol", "action", "price",
            "trade_comment", "trade_id",
            "position", "order_size", "trade_size", "profit_loss", "balance",
            "real_balance", "free_cash", "position_change", "position_held",
            "unrealized_balance", "drawdown", "max_drawdown", "realized_drawdown", "max_realized_drawdown"
        ])

        BACKTEST_RESULTS_DIR = os.path.join(DATA_DIR, "backtest_results", strategy_name)
        os.makedirs(BACKTEST_RESULTS_DIR, exist_ok=True)
        out_final = os.path.join(BACKTEST_RESULTS_DIR, "all_trades_combined.csv")
        df_out.to_csv(out_final, index=False)
        print(f"Final backtest => {out_final}")

        result = compute_metrics(df_out, initial_balance, payload, BACKTEST_RESULTS_DIR, DATA_DIR)
        if isinstance(result, dict) and "df_out" in result:
            result["df_out"] = result["df_out"].to_dict("records")

        if early_stop_reason:
            result["message"] = early_stop_reason
        return result

    except Exception as e:
        print("Exception in run_backtest:", e)
        return {"status": "error", "message": str(e)}

if __name__ == "__main__":
    sample_payload = {
        "strategy_name": "test_strategy",
        "pairs": ["BTC/USDT"],
        "max_active_deals": 1,
        "initial_balance": 10000,
        "trading_fee": 0.1,
        "base_order_size": 100,
        "start_date": "2023-01-01",
        "end_date": "2023-12-31",
        "entry_conditions": [{"indicator": "RSI", "subfields": {"Timeframe": "1m", "RSI Length": 14, "Condition": "Less Than", "Signal Value": 30}}]
    }
    result = run_backtest(sample_payload)
    print(result)
