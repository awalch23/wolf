const binance = require('./binance.js');
const Symbol = require('./Symbol.js');
const Ticker = require('./Ticker.js');
const Queue = require('./Queue.js');
const twilio = require('./twilio.js');
const fs = require('fs');
const assert = require('assert');

module.exports = class Wolf {
    constructor(config) {
        this.config = config;
        this.symbol = null; //meta information about trading pair
        this.ticker = null; //bid/ask prices updated per tick
        this.queue = null; //queue for unfilled transactions
        this.state = {
            executing: false,
            consuming: false
        };
        this.init();
    }

    //get trading pair information and initiate ticker
    async init() {
        //.env stringifies its values.  we convert these strings into numbers here so we don't have to later.
        this.config.budget = Number(this.config.budget);
        this.config.profitPercentage = Number(this.config.profitPercentage)/100;

        //get trading pair information
        const symbol = new Symbol({ tradingPair: this.config.tradingPair });
        this.symbol = await symbol.init();

        //setup/start ticker
        const tickerConfig = {
            tradingPair: this.config.tradingPair,
            callbacks: [ this.execute, this.consume ]
        };
        const ticker = new Ticker(tickerConfig);
        this.ticker = ticker.init();

        //setup/start queue
        const queue = new Queue({
            tradingPair: this.config.tradingPair,
            state: this.state
        });
        this.queue = queue.init();
    }

    //execute W.O.L.F
    execute() {
        if (this.state.executing) return;
        this.state.executing = true;
        this.logger('Executing...', '');
        this.purchase();
    }

    //digest the queue of open buy/sell orders
    async consume() {
        if (this.state.consuming) return;
        if (!this.queue.meta.length) return;

        this.state.consuming = true;
        this.logger('Consuming queue...', 'Orders in queue: ' + this.queue.meta.length);

        const filledTransactions = await this.queue.digest();

        //repopulate queue with closing (unconfirmed) transactions
        for (let orderId in filledTransactions) {
            const txn = filledTransactions[orderId];
            const price = Number(txn.price);
            if (txn.side === 'BUY') {
                const profit = price + (price * this.config.profitPercentage) + (price * .001));
                this.sell(Number(txn.executedQty), profit);
            }
            if (txn.side === 'SELL') {
                const profit = price - (price * this.config.profitPercentage);
                this.purchase(Number(txn.executedQty), profit);
            }
        }

        this.logger('Consumed queue.', 'Orders in queue: ' + this.queue.meta.length);
        this.state.consuming = false;
    }

    //calculate quantity of coin to purchase based on given budget from .env
    calculateQuantity() {
        this.logger('Calculating quantity...', '');
        const symbol = this.symbol.meta;
        const minQuantity = symbol.minQty;
        const maxQuantity = symbol.maxQty;
        const stepSize = symbol.stepSize;  //minimum quantity difference you can trade by
        const currentPrice = this.ticker.tick.ask;
        const budget = this.config.budget;

        let quantity = minQuantity;
        while (quantity * currentPrice <= budget) quantity += stepSize;
        if (quantity * currentPrice > budget) quantity -= stepSize;
        if (quantity === 0) quantity = minQuantity;

        assert(quantity >= minQuantity && quantity <= maxQuantity, 'invalid quantity');

        this.logger('Quantity Calculated: ', quantity.toFixed(8));
        return quantity.toFixed(8);
    }

    //purchase quantity of coin @ this.tick.bid and only continue executing W.O.L.F if this limit buy order is FILLED.
    async purchase(quantity, price) {
        try {
            const symbol = this.symbol.meta;
            const tickSize = symbol.tickSize;  //minimum price difference you can trade by
            const sigFig = symbol.sigFig;
            const unconfirmedPurchase = await binance.order({
                symbol: this.config.tradingPair,
                side: 'BUY',
                quantity: (quantity && quantity.toFixed(8)) || this.calculateQuantity(),
                price: (price && price.toFixed(sigFig)) || (this.ticker.meta.bid + tickSize).toFixed(sigFig)
            });
            this.queue.push(unconfirmedPurchase);
            this.logger('Purchasing...', unconfirmedPurchase.symbol);
        } catch(err) {
            return this.logger('PURCHASE ERROR: ', err.message);
        }
    }

    //sell quantity of coin and only continue executing W.O.L.F if this limit sell order is FILLED.
    async sell(quantity, profit) {
        try {
            const symbol = this.symbol.meta;
            const tickSize = symbol.tickSize;  //minimum price difference you can trade by
            const sigFig = symbol.sigFig;
            const unconfirmedSell = await binance.order({
                symbol: this.config.tradingPair,
                side: 'SELL',
                quantity: quantity.toFixed(8),
                price: profit.toFixed(sigFig)
            });
            this.queue.push(unconfirmedSell);
            this.logger('Selling...', unconfirmedSell.symbol);
        } catch(err) {
            return this.logger('SELL ERROR: ', err.message);
        }
    }

    //function to stop W.O.L.F and kill the node process
    terminate() {
        this.logger('Terminating W.O.L.F...');
        process.exit(0);
    }

    //utility function to console.log formatted messages
    logger(a, b) {
        if (process.env.LOGGING === 'true' || process.env.LOGGING === 'TRUE') {
            console.log(`[WOLF]:::: ${a} ${b}`);
        }
    }

    //function to log profits to a ledger.csv file
    async writeToLedger(date, pair, side, amount, price) {
        fs.appendFileSync('ledger.csv', `${date} ${pair} ${side} ${amount} ${price} \n`);
    }
};
