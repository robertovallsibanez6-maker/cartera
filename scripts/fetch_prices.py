#!/usr/bin/env python3
"""
Descarga precios, histórico y eventos (dividendos, resultados) para los
instrumentos de data/instruments.json usando Yahoo Finance (yfinance).

Genera:
  data/prices.json  -> último precio, variación del día, histórico diario (2 años), tipo de cambio
  data/events.json  -> próximos dividendos y fechas de resultados
  data/tickers.json -> caché de la resolución ISIN -> ticker de Yahoo
  data/status.json  -> resumen de la última ejecución (errores incluidos)

Se ejecuta en GitHub Actions. No necesita claves.
"""
import json
import os
import sys
import time
import datetime as dt
from pathlib import Path

import requests
import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
HISTORY_PERIOD = "2y"
HEADERS = {"User-Agent": "Mozilla/5.0 (cartera-app; +https://github.com)"}


def log(msg):
    print(f"[{dt.datetime.utcnow().strftime('%H:%M:%S')}] {msg}", flush=True)


def load_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def search_yahoo(query, prefer_currency="EUR", prefer_types=("MUTUALFUND", "ETF", "EQUITY")):
    """Busca un ticker en Yahoo por ISIN o nombre. Devuelve el mejor símbolo o None."""
    url = "https://query2.finance.yahoo.com/v1/finance/search"
    try:
        r = requests.get(url, params={"q": query, "quotesCount": 10, "newsCount": 0}, headers=HEADERS, timeout=20)
        r.raise_for_status()
        quotes = r.json().get("quotes", [])
    except Exception as e:
        log(f"  búsqueda fallida para {query}: {e}")
        return None
    if not quotes:
        return None

    def score(q):
        s = 0
        if q.get("quoteType") in prefer_types:
            s += 10 - prefer_types.index(q.get("quoteType"))
        sym = q.get("symbol", "")
        # Preferimos clases en euros y listados europeos
        if sym.endswith(".F") or sym.endswith(".DE") or sym.endswith(".MC") or sym.endswith(".BC"):
            s += 3
        if q.get("exchange") in ("FRA", "GER", "MCE", "BCN"):
            s += 2
        return s

    quotes.sort(key=score, reverse=True)
    return quotes[0].get("symbol")


def resolve_tickers(instruments, cache):
    resolved = {}
    for ins in instruments:
        iid = ins["id"]
        if ins.get("yahoo"):
            resolved[iid] = ins["yahoo"]
            continue
        if iid in cache and cache[iid]:
            resolved[iid] = cache[iid]
            continue
        # Lista de candidatos: nos quedamos con el primero que tenga histórico
        for cand in ins.get("yahoo_candidates", []):
            try:
                _, series = fetch_history(cand)
                if len(series) > 20:
                    log(f"  {iid}: candidato válido {cand} ({len(series)} cierres)")
                    resolved[iid] = cand
                    cache[iid] = cand
                    break
            except Exception as e:
                log(f"  {iid}: candidato {cand} sin datos ({e})")
        if resolved.get(iid):
            continue
        sym = search_yahoo(ins.get("isin") or ins["name"])
        if sym:
            log(f"  {iid}: resuelto {ins.get('isin')} -> {sym}")
            resolved[iid] = sym
            cache[iid] = sym
        else:
            log(f"  {iid}: sin ticker en Yahoo (se usará precio manual)")
            resolved[iid] = None
    return resolved


def fetch_history(symbol):
    tk = yf.Ticker(symbol)
    hist = tk.history(period=HISTORY_PERIOD, interval="1d", auto_adjust=False)
    if hist is None or hist.empty:
        raise ValueError("histórico vacío")
    closes = hist["Close"].dropna()
    series = [[d.strftime("%Y-%m-%d"), round(float(v), 6)] for d, v in closes.items()]
    return tk, series


def fetch_quote(tk, series):
    """Último precio y variación del día. Usa fast_info si existe, si no el histórico."""
    price = None
    prev = None
    currency = None
    ts = None
    def fi_get(fi, key, attr):
        try:
            v = fi[key]
            if v is not None:
                return v
        except Exception:
            pass
        try:
            return getattr(fi, attr, None)
        except Exception:
            return None
    try:
        fi = tk.fast_info
        price = fi_get(fi, "lastPrice", "last_price")
        prev = fi_get(fi, "previousClose", "previous_close")
        currency = fi_get(fi, "currency", "currency")
    except Exception:
        pass
    if not price or price != price:  # None o NaN
        price = series[-1][1]
        prev = series[-2][1] if len(series) > 1 else None
    if not prev or prev != prev:
        prev = series[-2][1] if len(series) > 1 else price
    # Si el último cierre del histórico es de hoy, el "previo" correcto es el anterior
    today = dt.date.today().isoformat()
    if series and series[-1][0] == today and len(series) > 1 and abs(series[-1][1] - price) < 1e-9:
        prev = series[-2][1]
    change_pct = (price / prev - 1) * 100 if prev else 0.0
    ts = int(time.time())
    return {
        "price": round(float(price), 6),
        "prevClose": round(float(prev), 6) if prev else None,
        "changePct": round(float(change_pct), 4),
        "currency": currency,
        "time": ts,
        "lastDate": series[-1][0],
    }


def fetch_events(tk, ins):
    """Dividendos y resultados. Solo tiene sentido para acciones."""
    ev = {}
    if ins.get("type") != "stock":
        return ev
    try:
        cal = tk.calendar  # dict en yfinance >= 0.2.3x
        if isinstance(cal, dict):
            ed = cal.get("Earnings Date")
            if ed:
                ev["earnings"] = [d.isoformat() if hasattr(d, "isoformat") else str(d) for d in (ed if isinstance(ed, list) else [ed])]
            if cal.get("Ex-Dividend Date"):
                d = cal["Ex-Dividend Date"]
                ev["exDividend"] = d.isoformat() if hasattr(d, "isoformat") else str(d)
            if cal.get("Dividend Date"):
                d = cal["Dividend Date"]
                ev["payDate"] = d.isoformat() if hasattr(d, "isoformat") else str(d)
    except Exception as e:
        log(f"  calendario no disponible para {ins['id']}: {e}")
    try:
        divs = tk.dividends
        if divs is not None and not divs.empty:
            last = divs.tail(8)
            ev["dividendHistory"] = [[d.strftime("%Y-%m-%d"), round(float(v), 6)] for d, v in last.items()]
            # Dividendo anual aproximado (últimos 12 meses)
            cutoff = dt.datetime.now(tz=divs.index.tz) - dt.timedelta(days=365) if divs.index.tz else dt.datetime.now() - dt.timedelta(days=365)
            ttm = float(divs[divs.index >= cutoff].sum())
            ev["dividendTTM"] = round(ttm, 6)
    except Exception as e:
        log(f"  dividendos no disponibles para {ins['id']}: {e}")
    try:
        info = tk.get_info() if hasattr(tk, "get_info") else tk.info
        for k_src, k_dst in (("trailingPE", "pe"), ("forwardPE", "forwardPE"), ("marketCap", "marketCap"),
                             ("fiftyTwoWeekHigh", "high52"), ("fiftyTwoWeekLow", "low52"),
                             ("dividendYield", "dividendYield"), ("beta", "beta"), ("sector", "sectorYahoo"),
                             ("longName", "longName")):
            if info.get(k_src) is not None:
                ev[k_dst] = info[k_src]
    except Exception as e:
        log(f"  info no disponible para {ins['id']}: {e}")
    return ev


def main():
    cfg = load_json(DATA / "instruments.json", {})
    instruments = cfg.get("instruments", [])
    cache = load_json(DATA / "tickers.json", {})
    prev_prices = load_json(DATA / "prices.json", {})
    prev_events = load_json(DATA / "events.json", {})

    log("Resolviendo tickers…")
    tickers = resolve_tickers(instruments, cache)
    save_json(DATA / "tickers.json", cache)

    prices = {"updated": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), "fx": {}, "quotes": {}, "history": {}, "tickers": tickers}
    events = {"updated": prices["updated"], "instruments": {}}
    status = {"updated": prices["updated"], "ok": [], "errors": {}}

    # Tipo de cambio
    for fx in cfg.get("fx", []):
        try:
            tk, series = fetch_history(fx["yahoo"])
            q = fetch_quote(tk, series)
            prices["fx"][fx["pair"]] = {"price": q["price"], "changePct": q["changePct"], "history": series}
            log(f"FX {fx['pair']}: {q['price']}")
        except Exception as e:
            status["errors"][fx["pair"]] = str(e)
            if fx["pair"] in prev_prices.get("fx", {}):
                prices["fx"][fx["pair"]] = prev_prices["fx"][fx["pair"]]

    for ins in instruments:
        iid = ins["id"]
        sym = tickers.get(iid)
        if not sym:
            status["errors"][iid] = "sin ticker"
            continue
        try:
            tk, series = fetch_history(sym)
            q = fetch_quote(tk, series)
            q["symbol"] = sym
            if not q.get("currency"):
                q["currency"] = ins.get("currency")
            prices["quotes"][iid] = q
            prices["history"][iid] = series
            status["ok"].append(iid)
            log(f"{iid} ({sym}): {q['price']} {q['currency']} ({q['changePct']:+.2f}%) · {len(series)} cierres")
            if not ins.get("closed"):
                ev = fetch_events(tk, ins)
                if ev:
                    events["instruments"][iid] = ev
            time.sleep(0.6)
        except Exception as e:
            status["errors"][iid] = str(e)
            log(f"{iid} ({sym}): ERROR {e}")
            # Conservamos lo anterior para no dejar la app sin datos
            if iid in prev_prices.get("quotes", {}):
                prices["quotes"][iid] = prev_prices["quotes"][iid]
                prices["history"][iid] = prev_prices.get("history", {}).get(iid, [])
            if iid in prev_events.get("instruments", {}):
                events["instruments"][iid] = prev_events["instruments"][iid]

    save_json(DATA / "prices.json", prices)
    save_json(DATA / "events.json", events)
    save_json(DATA / "status.json", status)
    log(f"Hecho: {len(status['ok'])} ok, {len(status['errors'])} con error")
    return 0


if __name__ == "__main__":
    sys.exit(main())
