const Binance = require('binance-api-node').default;
const { RSI, MACD, SMA } = require('technicalindicators');
const moment = require('moment');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const fs = require('fs');

const client = Binance();

// Configurazione
const symbol = 'BTCUSDT';
const interval = '1h';
const startDate = '2024-01-01';
const endDate = '2024-12-22';
const rsiPeriod = 14;
const macdSettings = {
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9
};

async function fetchKlines() {
    console.log('Scaricamento dati da:', startDate, 'a:', endDate);
    let allKlines = [];
    let currentStartTime = moment(startDate).valueOf();
    const endTime = moment(endDate).valueOf();
    
    while (currentStartTime < endTime) {
        console.log(`Scaricamento batch da ${moment(currentStartTime).format('YYYY-MM-DD')}`);
        const klines = await client.candles({
            symbol: symbol,
            interval: interval,
            startTime: currentStartTime,
            limit: 1000  // Massimo numero di candele per richiesta
        });
        
        if (klines.length === 0) break;
        
        allKlines = allKlines.concat(klines);
        currentStartTime = klines[klines.length - 1].closeTime + 1;
        
        // Piccola pausa per evitare rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`Scaricate ${allKlines.length} candele in totale`);
    return allKlines.map(candle => ({
        timestamp: moment(candle.openTime).format('YYYY-MM-DD HH:mm:ss'),
        open: parseFloat(candle.open),
        high: parseFloat(candle.high),
        low: parseFloat(candle.low),
        close: parseFloat(candle.close),
        volume: parseFloat(candle.volume)
    }));
}

function calculateIndicators(data) {
    // Calcola RSI
    const rsi = RSI.calculate({
        values: data.map(d => d.close),
        period: rsiPeriod
    });

    // Calcola MACD
    const macd = MACD.calculate({
        values: data.map(d => d.close),
        fastPeriod: macdSettings.fastPeriod,
        slowPeriod: macdSettings.slowPeriod,
        signalPeriod: macdSettings.signalPeriod
    });

    // Calcola le medie mobili
    const sma20 = SMA.calculate({
        values: data.map(d => d.close),
        period: 20
    });

    const sma50 = SMA.calculate({
        values: data.map(d => d.close),
        period: 50
    });

    return { rsi, macd, sma20, sma50 };
}

function backtest(data, indicators, isTraining = true) {
    console.log(`Inizio backtest su ${data.length} candele`);
    console.log(`Indicatori disponibili: RSI (${indicators.rsi.length}), MACD (${indicators.macd.length})`);
    
    const trades = [];
    let position = null;
    let balance = 10000;
    let wins = 0;
    let losses = 0;
    let maxDrawdown = 0;
    let peakBalance = balance;

    // Troviamo l'offset corretto per iniziare il backtest
    const startOffset = Math.max(
        data.length - indicators.rsi.length,
        data.length - indicators.macd.length,
        data.length - indicators.sma20.length,
        data.length - indicators.sma50.length,
        50
    );

    console.log(`Iniziamo il backtest dall'indice ${startOffset}`);

    for (let i = startOffset; i < data.length; i++) {
        const rsiIndex = i - startOffset;
        const macdIndex = i - startOffset;
        const sma20Index = i - startOffset;
        const sma50Index = i - startOffset;

        // Verifichiamo che gli indicatori siano definiti
        if (!indicators.rsi[rsiIndex] || !indicators.macd[macdIndex] || 
            !indicators.sma20[sma20Index] || !indicators.sma50[sma50Index]) {
            continue;
        }

        const currentRsi = indicators.rsi[rsiIndex];
        const currentMacd = indicators.macd[macdIndex];
        const currentPrice = data[i].close;
        const currentVolume = data[i].volume;

        // Calcola il volume medio degli ultimi 20 periodi
        const avgVolume = data.slice(Math.max(0, i-20), i)
            .reduce((sum, d) => sum + d.volume, 0) / Math.min(20, i);

        // Debug dei valori
        if (i % 100 === 0) {
            console.log(`\nDebug al timestamp ${data[i].timestamp}:`);
            console.log(`RSI: ${currentRsi.toFixed(2)}`);
            console.log(`MACD: ${currentMacd.MACD.toFixed(2)}, Signal: ${currentMacd.signal.toFixed(2)}`);
            console.log(`Prezzo: ${currentPrice}`);
            console.log(`Volume: ${currentVolume.toFixed(2)} (media: ${avgVolume.toFixed(2)})`);
        }

        // Calcola la volatilità degli ultimi 20 periodi
        const returns = data.slice(Math.max(0, i-20), i).map((d, idx, arr) => {
            if (idx === 0) return 0;
            return (d.close - arr[idx-1].close) / arr[idx-1].close;
        });
        const volatility = Math.sqrt(returns.reduce((sum, r) => sum + r * r, 0) / returns.length);

        // Condizioni di entrata long
        const isOversold = currentRsi < 40;
        const isMacdPositive = currentMacd.MACD > currentMacd.signal;
        const isUptrend = indicators.sma20[sma20Index] > indicators.sma50[sma50Index];
        const isHighVolume = currentVolume > avgVolume * 1.2;
        const isLowVolatility = volatility < 0.03;

        if (!position && isOversold && isMacdPositive && isUptrend && isHighVolume && isLowVolatility) {
            console.log(`\nSegnale di entrata trovato al ${data[i].timestamp}`);
            console.log(`RSI: ${currentRsi.toFixed(2)}, MACD: ${currentMacd.MACD.toFixed(2)}, Signal: ${currentMacd.signal.toFixed(2)}`);
            console.log(`Volume: ${currentVolume.toFixed(2)} (${(currentVolume/avgVolume).toFixed(2)}x media)`);
            
            const stopLossPercent = Math.max(0.8, volatility * 100);
            const takeProfitPercent = stopLossPercent * 1.5;

            position = {
                type: 'long',
                entryPrice: currentPrice,
                stopLoss: currentPrice * (1 - stopLossPercent/100),
                takeProfit: currentPrice * (1 + takeProfitPercent/100),
                entryTime: data[i].timestamp
            };
        }

        // Gestione della posizione
        if (position) {
            // Trailing stop loss
            const newStopLoss = currentPrice * 0.985;
            if (newStopLoss > position.stopLoss) {
                position.stopLoss = newStopLoss;
            }

            if (currentPrice <= position.stopLoss) {
                const lossPercent = (position.stopLoss - position.entryPrice) / position.entryPrice;
                balance *= (1 + lossPercent);
                losses++;
                console.log(`\nStop Loss hit al ${data[i].timestamp}`);
                console.log(`Perdita: ${(lossPercent*100).toFixed(2)}%`);
                position = null;
            } else if (currentPrice >= position.takeProfit) {
                const profitPercent = (position.takeProfit - position.entryPrice) / position.entryPrice;
                balance *= (1 + profitPercent);
                wins++;
                console.log(`\nTake Profit hit al ${data[i].timestamp}`);
                console.log(`Profitto: ${(profitPercent*100).toFixed(2)}%`);
                position = null;
            }
        }

        // Calcola drawdown
        if (balance > peakBalance) {
            peakBalance = balance;
        }
        const currentDrawdown = (peakBalance - balance) / peakBalance;
        maxDrawdown = Math.max(maxDrawdown, currentDrawdown);
    }

    const totalTrades = wins + losses;
    const winRate = (wins / totalTrades) * 100;
    const finalReturn = ((balance - 10000) / 10000) * 100;
    const profitFactor = wins > 0 ? (balance - 10000) / Math.abs(10000 - balance) : 0;

    return {
        balance,
        wins,
        losses,
        totalTrades,
        winRate,
        finalReturn,
        maxDrawdown: maxDrawdown * 100,
        profitFactor
    };
}

async function main() {
    try {
        console.log('Inizia scaricamento dati...');
        const data = await fetchKlines();
        console.log('Dati scaricati con successo');
        
        // Dividi i dati in training e testing
        const splitIndex = Math.floor(data.length / 2);
        const trainingData = data.slice(0, splitIndex);
        const testingData = data.slice(splitIndex);

        console.log(`\nDati divisi in:`);
        console.log(`- Training: ${trainingData.length} candele (${trainingData[0].timestamp} - ${trainingData[trainingData.length-1].timestamp})`);
        console.log(`- Testing: ${testingData.length} candele (${testingData[0].timestamp} - ${testingData[testingData.length-1].timestamp})`);

        // Training
        const trainingIndicators = calculateIndicators(trainingData);
        const trainingResults = backtest(trainingData, trainingIndicators, true);

        // Testing
        const testingIndicators = calculateIndicators(testingData);
        const testingResults = backtest(testingData, testingIndicators, false);

        console.log('\nRisultati Training:');
        console.log('-------------------');
        console.log(`Bilancio Finale: $${trainingResults.balance.toFixed(2)}`);
        console.log(`Trades Vincenti: ${trainingResults.wins}`);
        console.log(`Trades Perdenti: ${trainingResults.losses}`);
        console.log(`Win Rate: ${trainingResults.winRate.toFixed(2)}%`);
        console.log(`Rendimento: ${trainingResults.finalReturn.toFixed(2)}%`);
        console.log(`Max Drawdown: ${trainingResults.maxDrawdown.toFixed(2)}%`);
        console.log(`Profit Factor: ${trainingResults.profitFactor.toFixed(2)}`);

        console.log('\nRisultati Testing:');
        console.log('------------------');
        console.log(`Bilancio Finale: $${testingResults.balance.toFixed(2)}`);
        console.log(`Trades Vincenti: ${testingResults.wins}`);
        console.log(`Trades Perdenti: ${testingResults.losses}`);
        console.log(`Win Rate: ${testingResults.winRate.toFixed(2)}%`);
        console.log(`Rendimento: ${testingResults.finalReturn.toFixed(2)}%`);
        console.log(`Max Drawdown: ${testingResults.maxDrawdown.toFixed(2)}%`);
        console.log(`Profit Factor: ${testingResults.profitFactor.toFixed(2)}`);

    } catch (error) {
        console.error('Errore durante l\'esecuzione:', error);
    }
}

main();