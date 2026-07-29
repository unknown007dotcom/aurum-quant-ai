const AnalysisEngine = {
    toNumber(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    },

    normalizeCandles(candles) {
        if (!Array.isArray(candles)) return [];
        return candles
            .map((candle) => ({
                ...candle,
                open: Number(candle?.open),
                high: Number(candle?.high),
                low: Number(candle?.low),
                close: Number(candle?.close),
                _ts: new Date(candle?.datetime || 0).getTime(),
            }))
            .filter((candle) => 
                Number.isFinite(candle.open) && candle.open > 0 &&
                Number.isFinite(candle.high) && candle.high > 0 &&
                Number.isFinite(candle.low) && candle.low > 0 &&
                Number.isFinite(candle.close) && candle.close > 0
            )
            .sort((a, b) => a._ts - b._ts);
    },

    exponentialMovingAverage(values, period) {
        if (!Array.isArray(values) || values.length === 0) return [];
        const k = 2 / (period + 1);
        let ema = [values[0]];
        for (let i = 1; i < values.length; i++) ema.push(values[i] * k + ema[i - 1] * (1 - k));
        return ema;
    },

    averageTrueRange(candles, period) {
        if (!candles || candles.length === 0) return [];
        let tr = [candles[0].high - candles[0].low];
        for (let i = 1; i < candles.length; i++) {
            tr.push(Math.max(
                candles[i].high - candles[i].low,
                Math.abs(candles[i].high - candles[i - 1].close),
                Math.abs(candles[i].low - candles[i - 1].close)
            ));
        }
        let atr = [tr[0]];
        for (let i = 1; i < tr.length; i++) {
            atr.push((atr[i - 1] * (period - 1) + tr[i]) / period);
        }
        return atr;
    },

    calculateRMI(candles) {
        if (!candles || candles.length < 30) return 100.00;
        const closes = candles.map(c => c.close);
        const period = 30;
        const k = 2 / (period + 1);
        let ema = closes[0];
        for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
        const rmi = (closes.at(-1) / ema) * 100;
        return parseFloat(rmi.toFixed(2));
    },

    detectFairValueGaps(candles) {
        const fvgs = [];
        const isBull = (c) => c.close > c.open;
        const isBear = (c) => c.close < c.open;

        for (let i = 1; i < candles.length - 1; i++) {
            const p = candles[i - 1];
            const curr = candles[i];
            const n = candles[i + 1];

            const isGapUp = curr.open > p.close;
            const isGapDown = curr.open < p.close;

            // Bullish FVG or Gap Up
            if ((n.low > p.high && isBull(curr)) || isGapUp) {
                let type = isGapUp ? "Gap Up FVG" : "Standard";
                if (isBull(p) && isBull(n)) type = isGapUp ? "Gap Up (FOMO Trap)" : "Exhaustion FVG (FOMO Trap)";
                else if (isBull(p) && isBear(n)) type = isGapUp ? "Gap Up (Trade Continuation)" : "Trade Continuation";
                else if (isBear(p) && isBull(n)) type = isGapUp ? "Gap Up (The Sweep)" : "The Sweep (Delayed Trap)";
                else if (isBear(p) && isBear(n)) type = isGapUp ? "Gap Up (Holy Grail)" : "The Holy Grail (Ultimate Jackpot ⭐⭐⭐⭐⭐)";

                const price = isGapUp ? (curr.open + p.close) / 2 : (n.low + p.high) / 2;
                if (!fvgs.some(f => f.side === "bullish" && Math.abs(f.price - price) < 0.05)) {
                    fvgs.push({ side: "bullish", price, type });
                }
            }
            // Bearish FVG or Gap Down
            else if ((n.high < p.low && isBear(curr)) || isGapDown) {
                let type = isGapDown ? "Gap Down FVG" : "Standard";
                if (isBear(p) && isBear(n)) type = isGapDown ? "Gap Down (FOMO Trap)" : "Exhaustion FVG (FOMO Trap)";
                else if (isBear(p) && isBull(n)) type = isGapDown ? "Gap Down (Trade Continuation)" : "Trade Continuation";
                else if (isBull(p) && isBear(n)) type = isGapDown ? "Gap Down (The Sweep)" : "The Sweep (Delayed Trap)";
                else if (isBull(p) && isBull(n)) type = isGapDown ? "Gap Down (Holy Grail)" : "The Holy Grail (Ultimate Jackpot ⭐⭐⭐⭐⭐)";

                const price = isGapDown ? (curr.open + p.close) / 2 : (n.high + p.low) / 2;
                if (!fvgs.some(f => f.side === "bearish" && Math.abs(f.price - price) < 0.05)) {
                    fvgs.push({ side: "bearish", price, type });
                }
            }
        }
        return fvgs.slice(-8);
    },

    detectStructureEvents(candles) {
        const events = [];
        for (let i = 2; i < candles.length; i++) {
            const current = candles[i];
            const previous = candles[i - 1];
            const pivot = candles[i - 2];
            if (current.high > previous.high && previous.high <= pivot.high) {
                events.push(`BOS up through ${previous.high.toFixed(2)}`);
            }
            if (current.low < previous.low && previous.low >= pivot.low) {
                events.push(`Liquidity sweep below ${previous.low.toFixed(2)}`);
            }
        }
        return events.slice(-6);
    },

    detectOrderBlocks(candles, trend) {
        const relevant = candles.slice(-12, -1);
        const matches = relevant
            .filter((candle) => trend === "bullish" ? candle.close < candle.open : candle.close > candle.open)
            .slice(-3)
            .map((candle) => {
                const side = trend === "bullish" ? "Bullish demand" : "Bearish supply";
                return `${side} ${candle.low.toFixed(2)} - ${candle.high.toFixed(2)}`;
            });
        return matches.length ? matches : ["No clean order block found in current scan window."];
    },

    detectSwings(candles, strength) {
        const highs = [];
        const lows = [];
        for (let i = strength; i < candles.length - strength; i++) {
            let isHigh = true;
            let isLow = true;
            for (let j = 1; j <= strength; j++) {
                if (candles[i].high < candles[i - j].high || candles[i].high < candles[i + j].high) isHigh = false;
                if (candles[i].low > candles[i - j].low || candles[i].low > candles[i + j].low) isLow = false;
            }
            if (isHigh) highs.push({ index: i, price: candles[i].high });
            if (isLow) lows.push({ index: i, price: candles[i].low });
        }
        return { highs, lows };
    },

    detectFibonacci(candles, currentPrice) {
        const swings = this.detectSwings(candles, 3);
        if (!swings || !swings.highs.length || !swings.lows.length) return null;

        const allSwings = [];
        swings.highs.forEach(s => allSwings.push({ ...s, type: 'high' }));
        swings.lows.forEach(s => allSwings.push({ ...s, type: 'low' }));
        allSwings.sort((a, b) => a.index - b.index);

        if (allSwings.length < 2) return null;

        const lastSwing = allSwings[allSwings.length - 1];
        let prevSwing = null;
        for (let i = allSwings.length - 2; i >= 0; i--) {
            if (allSwings[i].type !== lastSwing.type) {
                prevSwing = allSwings[i];
                break;
            }
        }

        if (!prevSwing) return null;

        const isBullishImpulse = lastSwing.type === 'high' && prevSwing.type === 'low';
        
        let highPrice = isBullishImpulse ? lastSwing.price : prevSwing.price;
        let lowPrice = !isBullishImpulse ? lastSwing.price : prevSwing.price;
        let range = highPrice - lowPrice;

        if (range <= 0) return null;

        let levels = {};
        if (isBullishImpulse) {
            levels = { 0: highPrice, 0.618: highPrice - (range * 0.618), 0.705: highPrice - (range * 0.705), 1: lowPrice };
        } else {
            levels = { 0: lowPrice, 0.618: lowPrice + (range * 0.618), 0.705: lowPrice + (range * 0.705), 1: highPrice };
        }

        let inEntryZone = isBullishImpulse 
            ? (currentPrice <= levels[0.618] && currentPrice >= levels[0.705])
            : (currentPrice >= levels[0.618] && currentPrice <= levels[0.705]);

        return {
            isBullishImpulse,
            levels,
            inEntryZone,
            action: isBullishImpulse ? "Buy" : "Sell",
            tp: levels[0],
            sl: levels[1],
            displayList: [
                `Direction: ${isBullishImpulse ? 'Bullish' : 'Bearish'} Retracement`,
                `Level 0 (TP): ${levels[0].toFixed(2)}`,
                `Level 0.618 (Entry): ${levels[0.618].toFixed(2)}`,
                `Level 0.705 (Entry): ${levels[0.705].toFixed(2)}`,
                `Level 1 (SL): ${levels[1].toFixed(2)}`,
                `Status: ${inEntryZone ? '🟢 IN ENTRY ZONE' : '⚪ Pending'}`
            ]
        };
    }
};

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
    module.exports = { AnalysisEngine };
} else {
    globalThis.AnalysisEngine = AnalysisEngine;
}
