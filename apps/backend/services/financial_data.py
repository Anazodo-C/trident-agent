import httpx
import logging
import json
import math
from config import get_settings
from services import cache as api_cache

logger = logging.getLogger(__name__)
settings = get_settings()

COINGECKO_IDS = {
    "BTC": "bitcoin", "ETH": "ethereum", "USDC": "usd-coin",
    "SOL": "solana", "MATIC": "matic-network", "ARB": "arbitrum",
    "OP": "optimism", "LINK": "chainlink", "AAVE": "aave",
}

# Assumed annualised returns and volatilities for portfolio math
ASSET_STATS = {
    "BTC":  {"ret": 0.30, "vol": 0.60},
    "ETH":  {"ret": 0.25, "vol": 0.65},
    "SOL":  {"ret": 0.40, "vol": 0.80},
    "USDC": {"ret": 0.04, "vol": 0.005},
    "MATIC":{"ret": 0.20, "vol": 0.70},
    "ARB":  {"ret": 0.22, "vol": 0.72},
    "LINK": {"ret": 0.18, "vol": 0.58},
    "AAVE": {"ret": 0.20, "vol": 0.65},
    "BNB":  {"ret": 0.22, "vol": 0.55},
}
RISK_FREE_RATE = 0.05  # 5% annualised


class FinancialDataService:

    async def get_price_feed(self, symbols: list[str]) -> dict:
        CACHE_TTL = 15.0
        cache_key = f"prices_{'_'.join(sorted(symbols))}"

        cached = api_cache.get(cache_key, ttl=CACHE_TTL)
        if cached is not None:
            logger.debug(f"[cache] price feed served from cache")
            return cached

        ids = [COINGECKO_IDS.get(s, s.lower()) for s in symbols]
        raw: dict = {}
        try:
            async with httpx.AsyncClient() as client:
                r = await client.get(
                    "https://api.coingecko.com/api/v3/simple/price",
                    params={
                        "ids": ",".join(ids),
                        "vs_currencies": "usd",
                        "include_24hr_change": "true",
                        "include_market_cap": "true",
                    },
                    headers={"x-cg-demo-api-key": settings.coingecko_api_key} if settings.coingecko_api_key else {},
                    timeout=10,
                )
                r.raise_for_status()
                raw = r.json()
        except Exception as e:
            logger.warning(f"CoinGecko fetch failed: {e}")
            # Fall back to stale cache (up to 1h old)
            stale = api_cache.get(cache_key, ttl=3600.0)
            if stale:
                logger.info("[cache] serving stale price data")
                return stale

        result = {}
        for sym in symbols:
            cg_id = COINGECKO_IDS.get(sym, sym.lower())
            entry = raw.get(cg_id, {})
            result[sym] = {
                "usd": entry.get("usd", 0),
                "change_24h": round(entry.get("usd_24h_change", 0) or 0, 2),
                "market_cap": entry.get("usd_market_cap", 0),
            }

        if result:
            api_cache.set(cache_key, result)
        return result

    async def get_fx_rates(self, base: str, targets: list[str]) -> dict:
        """
        Fetch FX rates with a two-layer strategy + in-memory cache:

        1. Check cache (15s TTL) — return immediately if fresh.
        2. Try exchangerate.host — one call for all pairs, free, no key needed.
        3. Alpha Vantage fallback — per missing pair, max 5 calls/min safe.
           BRL is excluded from the AV fallback to stay within the 5-call limit.
        4. For any pair still missing, serve the last known cached value (stale-ok).

        Cache entries are swept hourly; storage is negligible (< 20 entries, ~1 KB).
        """
        CACHE_TTL = 15.0     # seconds — return cached if fresher than this
        # BRL dropped from AV fallback: EUR, GBP, NGN, JPY, GHS = 5 (exactly the limit)
        AV_EXCLUDED = {"BRL"}

        cache_key = f"fx_{base}_{'_'.join(sorted(targets))}"

        # 1. Cache hit
        cached = api_cache.get(cache_key, ttl=CACHE_TTL)
        if cached is not None:
            logger.debug(f"[cache] FX rates served from cache (key={cache_key})")
            return cached

        flat_rates: dict[str, float] = {}

        # 2a. frankfurter.app — ECB-backed, unlimited free, no key, reliable for major pairs
        #     Supports: EUR GBP JPY and ~30 other OECD currencies. Does NOT support NGN/GHS.
        FRANKFURTER_SUPPORTED = {"EUR","GBP","JPY","CHF","AUD","CAD","NZD","SEK","NOK","DKK","PLN","CZK","HUF","RON","BGN","HRK","TRY","ZAR","MXN","BRL","SGD","HKD","INR","KRW","IDR","MYR","PHP","THB","VND","AED","SAR","ILS","CNY"}
        frank_targets = [t for t in targets if t in FRANKFURTER_SUPPORTED]
        if frank_targets:
            try:
                async with httpx.AsyncClient() as client:
                    r = await client.get(
                        "https://api.frankfurter.app/latest",
                        params={"from": base, "to": ",".join(frank_targets)},
                        timeout=8,
                    )
                    data = r.json()
                    for k, v in data.get("rates", {}).items():
                        if k in targets:
                            flat_rates[k] = round(float(v), 6)
                    logger.info(f"[fx] frankfurter returned {len(flat_rates)}/{len(frank_targets)} pairs")
            except Exception as e:
                logger.warning(f"[fx] frankfurter.app failed: {e}")

        # 2b. exchangerate-api.com v6 free tier — no key, supports NGN, GHS and 160+ currencies
        remaining_after_frank = [t for t in targets if t not in flat_rates]
        if remaining_after_frank:
            try:
                async with httpx.AsyncClient() as client:
                    r = await client.get(
                        f"https://api.exchangerate-api.com/v4/latest/{base}",
                        timeout=10,
                    )
                    data = r.json()
                    for k, v in data.get("rates", {}).items():
                        if k in remaining_after_frank:
                            flat_rates[k] = round(float(v), 6)
                    logger.info(f"[fx] exchangerate-api.com filled: {remaining_after_frank}")
            except Exception as e:
                logger.warning(f"[fx] exchangerate-api.com failed: {e}")

        # 3. Alpha Vantage per-pair fallback (skip AV_EXCLUDED, max 5 calls)
        missing = [t for t in targets if t not in flat_rates and t not in AV_EXCLUDED]
        if missing and settings.alpha_vantage_api_key:
            try:
                async with httpx.AsyncClient() as client:
                    for target in missing[:5]:
                        r = await client.get(
                            "https://www.alphavantage.co/query",
                            params={
                                "function": "CURRENCY_EXCHANGE_RATE",
                                "from_currency": base,
                                "to_currency": target,
                                "apikey": settings.alpha_vantage_api_key,
                            },
                            timeout=8,
                        )
                        info = r.json().get("Realtime Currency Exchange Rate", {})
                        rate_str = info.get("5. Exchange Rate")
                        if rate_str:
                            flat_rates[target] = round(float(rate_str), 6)
                            logger.info(f"[fx] Alpha Vantage filled {target}={flat_rates[target]}")
            except Exception as e:
                logger.warning(f"[fx] Alpha Vantage fallback failed: {e}")

        # 4. Stale-cache fill-in for anything still missing
        stale = api_cache.get(cache_key, ttl=3600.0)  # accept up to 1h old
        if stale and len(flat_rates) < len(targets):
            for k, v in stale.items():
                if k not in flat_rates:
                    flat_rates[k] = v
                    logger.info(f"[fx] serving stale cache for {k}")

        # Store result (even partial) — overwrites previous cache entry
        if flat_rates:
            api_cache.set(cache_key, flat_rates)

        return flat_rates  # plain {EUR: 0.9214, GBP: 0.7891, ...}

    async def get_risk_score(self, address: str) -> dict:
        """
        Deterministic address risk score.

        Methodology (heuristic — for demo/testnet):
        • Takes the first 4 hex nibbles of the address after "0x"
        • Converts to integer mod 100 to get a stable 0–99 score
        • Not real on-chain activity analysis (that would require an indexer like Nansen/Etherscan)

        Score bands:
          0–29  → Low risk   (clean/new wallet, minimal DeFi exposure)
          30–69 → Medium risk (active DeFi user, some protocol exposure)
          70–99 → High risk  (high activity, cross-protocol, possible flag)
        """
        addr = address.strip()
        if addr.startswith("0x") and len(addr) >= 6:
            score = int(addr[2:6], 16) % 100
        else:
            score = 50

        risk_level = "low" if score < 30 else "medium" if score < 70 else "high"

        # Derive plausible factor labels from score bands
        if score < 30:
            factors = ["Minimal DeFi protocol exposure", "Clean transaction history", "No sanctions list hits", "Low cross-chain activity"]
        elif score < 70:
            factors = ["Active DeFi user (3+ protocols)", "Moderate leverage history", "No sanctions hits", "Cross-chain bridging detected"]
        else:
            factors = ["High-frequency transaction pattern", "Multiple DeFi protocols (5+)", "Cross-chain bridge activity", "Elevated counterparty risk"]

        return {
            "address": addr,
            "risk_score": score,
            "risk_level": risk_level,
            "label": risk_level.capitalize() + " Risk",
            "factors": factors,
            "methodology": "Deterministic address heuristic (testnet). Production: Nansen / Chainalysis API.",
        }


    async def get_compute_score(self, portfolio: str, model: str = "sharpe") -> dict:
        """
        Portfolio analysis using weighted-average return/volatility assumptions.
        Input: 'BTC:0.4,ETH:0.3,SOL:0.2,USDC:0.1'
        """
        # Parse portfolio string → {ASSET: weight}
        weights: dict[str, float] = {}
        for item in portfolio.split(","):
            item = item.strip()
            if ":" in item:
                sym, w = item.split(":", 1)
                try:
                    weights[sym.strip().upper()] = float(w.strip())
                except ValueError:
                    pass
            elif item:
                weights[item.upper()] = 1.0 / max(len(portfolio.split(",")), 1)

        if not weights:
            weights = {"BTC": 0.5, "ETH": 0.5}

        # Normalise weights to sum to 1
        total_w = sum(weights.values())
        weights = {k: v / total_w for k, v in weights.items()}

        # Weighted portfolio return and volatility
        port_ret = sum(
            w * ASSET_STATS.get(sym, {"ret": 0.15, "vol": 0.60})["ret"]
            for sym, w in weights.items()
        )
        # Simplified variance: ignores correlations (conservative estimate)
        port_var = sum(
            (w ** 2) * (ASSET_STATS.get(sym, {"ret": 0.15, "vol": 0.60})["vol"] ** 2)
            for sym, w in weights.items()
        )
        port_vol = math.sqrt(port_var)

        sharpe = round((port_ret - RISK_FREE_RATE) / port_vol, 3) if port_vol > 0 else 0.0
        var_95  = round(-1.645 * port_vol / math.sqrt(252), 4)   # daily VaR 95%
        max_dd  = round(-port_vol * 1.8, 3)                       # rough max drawdown estimate

        if sharpe >= 2.0:
            signal = "strong buy"
        elif sharpe >= 1.0:
            signal = "buy"
        elif sharpe >= 0.5:
            signal = "hold"
        else:
            signal = "rebalance"

        portfolio_score = min(100, max(0, round(sharpe * 40 + 20)))

        return {
            "sharpe_ratio":      sharpe,
            "var_95":            var_95,
            "max_drawdown":      max_dd,
            "rebalance_signal":  signal,
            "score":             portfolio_score,
            "portfolio_return":  round(port_ret * 100, 1),
            "portfolio_vol":     round(port_vol * 100, 1),
            "weights":           {k: round(v, 3) for k, v in weights.items()},
            "model":             model,
            "note": "Simplified model using assumed annual returns/volatility. Production: feed real historical returns.",
        }
