import assert from "node:assert/strict";

const USER_ID = "507f1f77bcf86cd799439011";
const WALLET_ID = "507f1f77bcf86cd799439015";
const PAYMENT_ID = "507f1f77bcf86cd799439013";
const RAZORPAY_PAYMENT_ID = "pay_key_collision";
const CLIENT_KEY = "shared-client-key";
const INITIAL_BALANCE = 50000;
const REFUND_AMOUNT_PAISE = 10000;

// Patch the SDK before loading the controller, which constructs its own
// Razorpay client at module import time.
const Razorpay = require("razorpay");
const mongoose = require("mongoose");
const originalAddResources = Razorpay.prototype.addResources;

let razorpayRefundSequence = 0;
let transactionCollision = false;

const fakePayments = {
    refund: async (paymentId: any, params: any) => {
        razorpayRefundSequence += 1;
        return {
            id: `rfnd_key_collision_${razorpayRefundSequence}`,
            status: "processed",
            amount: params.amount,
            currency: params.currency ?? "INR",
            payment_id: paymentId,
            receipt: params.receipt
        };
    }
};

Razorpay.prototype.addResources = function () {
    originalAddResources.call(this);
    this.payments = fakePayments;
};

process.env.RAZORPAY_KEY_ID = "test_key";
process.env.RAZORPAY_KEY_SECRET = "test_secret";

const { createRefund } = require("../controllers/payment.controller");
const Payment = require("../models/payment.models").default;
const Refund = require("../models/refund.models").default;
const Wallet = require("../models/wallet.models").default;
const Transaction = require("../models/transaction.models").default;
const Ledger = require("../models/ledger.models").default;

let refunds: any[] = [];
let payments: any[] = [];
let wallets: any[] = [];
let transactions: any[] = [];
let ledgers: any[] = [];
let refundSequence = 0;
let transactionSequence = 0;
let ledgerSequence = 0;

function clone(value: any): any {
    return value === undefined || value === null
        ? value
        : JSON.parse(JSON.stringify(value));
}

function snapshot() {
    return {
        refunds: clone(refunds),
        payments: clone(payments),
        wallets: clone(wallets),
        transactions: clone(transactions),
        ledgers: clone(ledgers)
    };
}

function restore(state: ReturnType<typeof snapshot>): void {
    refunds = state.refunds;
    payments = state.payments;
    wallets = state.wallets;
    transactions = state.transactions;
    ledgers = state.ledgers;
}

// Emulate transaction rollback so an E11000 during finalization cannot leave
// the already-snapshotted wallet/payment/refund writes visible.
const fakeSession = {
    withTransaction: async (fn: () => Promise<void>) => {
        const state = snapshot();
        try {
            await fn();
        } catch (error) {
            restore(state);
            throw error;
        }
    },
    inTransaction: () => false,
    abortTransaction: async () => undefined,
    endSession: async () => undefined
};

const originalStartSession = mongoose.startSession;
(mongoose as any).startSession = async () => fakeSession;

function isCondition(value: any): boolean {
    return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !(value instanceof Date) &&
        Object.keys(value).some((key) => key.startsWith("$"));
}

function matches(doc: any, filter: any): boolean {
    if (!filter) {
        return true;
    }

    for (const [field, expected] of Object.entries(filter)) {
        if (field === "$expr" || field === "$and") {
            continue;
        }

        if (field === "$or") {
            if (!Array.isArray(expected) || !expected.some((part) => matches(doc, part))) {
                return false;
            }
            continue;
        }

        const actual = doc?.[field];

        if (isCondition(expected)) {
            const condition = expected as Record<string, any>;
            const actualValues = Array.isArray(actual)
                ? actual.map((value) => String(value))
                : [String(actual)];

            if (
                "$in" in condition &&
                !condition.$in.some((value: unknown) => actualValues.includes(String(value)))
            ) {
                return false;
            }

            if (
                "$nin" in condition &&
                condition.$nin.some((value: unknown) => actualValues.includes(String(value)))
            ) {
                return false;
            }

            if (
                "$exists" in condition &&
                (actual !== undefined) !== Boolean(condition.$exists)
            ) {
                return false;
            }

            continue;
        }

        if (String(actual) !== String(expected)) {
            return false;
        }
    }

    return true;
}

function applyUpdate(doc: any, update: any): void {
    for (const [field, value] of Object.entries(update?.$set ?? {})) {
        doc[field] = value;
    }

    for (const [field, value] of Object.entries(update?.$inc ?? {})) {
        doc[field] = (doc[field] ?? 0) + Number(value);
    }

    for (const [field, value] of Object.entries(update?.$addToSet ?? {})) {
        if (!Array.isArray(doc[field])) {
            doc[field] = [];
        }

        const values = Array.isArray((value as any)?.$each) ? (value as any).$each : [value];
        for (const item of values) {
            if (!doc[field].some((existing: unknown) => String(existing) === String(item))) {
                doc[field].push(item);
            }
        }
    }

    doc.updatedAt = new Date();
}

(Payment as any).findById = async (id: any) =>
    payments.find((payment) => String(payment._id) === String(id)) ?? null;

(Payment as any).findOneAndUpdate = async (filter: any, update: any) => {
    const payment = payments.find((candidate) => matches(candidate, filter));
    if (!payment) {
        return null;
    }

    applyUpdate(payment, update);
    return payment;
};

(Refund as any).create = async (data: any) => {
    if (refunds.some((refund) => refund.idempotencyKey === data.idempotencyKey)) {
        throw { code: 11000 };
    }

    refundSequence += 1;
    const refund = {
        _id: `refund_collision_${refundSequence}`,
        razorpayRefundId: undefined,
        status: "CREATED",
        reservationActive: false,
        requiresReconciliation: false,
        failureReason: undefined,
        finalizedAt: undefined,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...data
    };

    refunds.push(refund);
    return refund;
};

(Refund as any).findOne = async (filter: any) =>
    refunds.find((refund) => matches(refund, filter)) ?? null;

(Refund as any).findById = async (id: any) =>
    refunds.find((refund) => String(refund._id) === String(id)) ?? null;

(Refund as any).findOneAndUpdate = async (filter: any, update: any) => {
    const refund = refunds.find((candidate) => matches(candidate, filter));
    if (!refund) {
        return null;
    }

    applyUpdate(refund, update);
    return refund;
};

(Refund as any).updateOne = async (filter: any, update: any) => {
    const refund = refunds.find((candidate) => matches(candidate, filter));
    if (!refund) {
        return { matchedCount: 0 };
    }

    applyUpdate(refund, update);
    return { matchedCount: 1 };
};

(Wallet as any).findOne = async (filter: any) =>
    wallets.find((wallet) => matches(wallet, filter)) ?? null;

(Wallet as any).findOneAndUpdate = async (filter: any, update: any) => {
    const wallet = wallets.find((candidate) => matches(candidate, filter));
    if (!wallet) {
        return null;
    }

    applyUpdate(wallet, update);
    return wallet;
};

(Transaction as any).prototype.save = async function (this: any) {
    if (transactionCollision || transactions.some((item) =>
        item.idempotencyKey === this.idempotencyKey
    )) {
        throw { code: 11000 };
    }

    transactionSequence += 1;
    this._id = this._id ?? `transaction_collision_${transactionSequence}`;
    transactions.push(this);
    return this;
};

(Ledger as any).prototype.save = async function (this: any) {
    ledgerSequence += 1;
    this._id = this._id ?? `ledger_collision_${ledgerSequence}`;
    ledgers.push(this);
    return this;
};

function reset(): void {
    refunds = [];
    payments = [];
    wallets = [];
    transactions = [];
    ledgers = [];
    refundSequence = 0;
    transactionSequence = 0;
    ledgerSequence = 0;
    razorpayRefundSequence = 0;
    transactionCollision = false;
}

function seedPayment(): any {
    const payment = {
        _id: PAYMENT_ID,
        userId: USER_ID,
        razorpayOrderId: "order_key_collision",
        razorpayPaymentId: RAZORPAY_PAYMENT_ID,
        amount: INITIAL_BALANCE,
        currency: "INR",
        refundedAmount: 0,
        reservedRefundAmount: 0,
        status: "SUCCESS"
    };

    payments.push(payment);
    return payment;
}

function seedWallet(): any {
    const wallet = {
        _id: WALLET_ID,
        ownerId: USER_ID,
        balance: INITIAL_BALANCE,
        reservedBalance: 0,
        currency: "INR",
        status: "active"
    };

    wallets.push(wallet);
    return wallet;
}

function makeReq(idempotencyKey: string, amount = 100): any {
    return {
        user: { userId: USER_ID },
        headers: { "idempotency-key": idempotencyKey },
        body: {
            paymentId: PAYMENT_ID,
            amount,
            reason: "key collision regression"
        },
        params: {}
    };
}

function makeRes() {
    const result: { statusCode?: number; body?: any } = {};
    const res: any = {
        status(code: number) {
            result.statusCode = code;
            return res;
        },
        json(body: any) {
            result.body = body;
            return res;
        }
    };

    return { res, result };
}

async function runRefund(req: any) {
    const { res, result } = makeRes();
    await createRefund(req, res);
    return result;
}

async function run(): Promise<void> {
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => undefined;
    console.error = () => undefined;

    try {
        // 1. A raw client key shared with the payment CREDIT must not collide
        //    with the refund DEBIT.
        {
            reset();
            seedPayment();
            const wallet = seedWallet();

            transactions.push({
                _id: "transaction_credit",
                walletId: WALLET_ID,
                type: "CREDIT",
                amount: INITIAL_BALANCE,
                currency: "INR",
                status: "Success",
                idempotencyKey: CLIENT_KEY,
                description: "Money added through Razorpay"
            });

            const result = await runRefund(makeReq(CLIENT_KEY));

            assert.equal(result.statusCode, 200);
            assert.equal(result.body.message, "Refund processed successfully.");

            const refund = refunds[0];
            assert.equal(refund.status, "PROCESSED");
            assert.equal(refund.idempotencyKey, CLIENT_KEY);

            const credit = transactions.find((item) => item.type === "CREDIT");
            const debit = transactions.find((item) => item.type === "DEBIT");
            assert.ok(credit);
            assert.ok(debit);
            assert.equal(credit.idempotencyKey, CLIENT_KEY);
            assert.equal(debit.idempotencyKey, `refund:${refund._id}`);
            assert.notEqual(debit.idempotencyKey, CLIENT_KEY);
            assert.equal(transactions.length, 2);

            assert.equal(wallet.balance, INITIAL_BALANCE - REFUND_AMOUNT_PAISE);
            assert.equal(payments[0].refundedAmount, REFUND_AMOUNT_PAISE);
            assert.equal(payments[0].reservedRefundAmount, 0);
            assert.equal(ledgers.length, 1);
            assert.equal(ledgers[0].type, "DEBIT");
        }

        // 2. Replaying the same refund request must not debit a second time.
        {
            const wallet = wallets[0];
            const transactionCount = transactions.length;
            const balanceAfterFirstRefund = wallet.balance;

            const result = await runRefund(makeReq(CLIENT_KEY));

            assert.equal(result.statusCode, 200);
            assert.equal(result.body.message, "Request already processed.");
            assert.equal(transactions.length, transactionCount);
            assert.equal(wallet.balance, balanceAfterFirstRefund);
            assert.equal(
                transactions.filter((item) => item.type === "DEBIT").length,
                1
            );
        }

        // 3. Different refunds receive distinct DEBIT transaction keys.
        {
            reset();
            const wallet = seedWallet();
            seedPayment();

            const first = await runRefund(makeReq("refund-key-a"));
            const second = await runRefund(makeReq("refund-key-b"));

            assert.equal(first.statusCode, 200);
            assert.equal(second.statusCode, 200);

            const debits = transactions.filter((item) => item.type === "DEBIT");
            assert.equal(debits.length, 2);
            assert.equal(debits[0].idempotencyKey, `refund:${refunds[0]._id}`);
            assert.equal(debits[1].idempotencyKey, `refund:${refunds[1]._id}`);
            assert.notEqual(debits[0].idempotencyKey, debits[1].idempotencyKey);

            assert.equal(
                wallet.balance,
                INITIAL_BALANCE - REFUND_AMOUNT_PAISE * 2
            );
            assert.equal(payments[0].refundedAmount, REFUND_AMOUNT_PAISE * 2);
            assert.equal(ledgers.length, 2);
        }

        // 4. An E11000 during finalization is unresolved, not proof of
        //    finalization. The transaction must roll back and flag reconciliation.
        {
            reset();
            const payment = seedPayment();
            const wallet = seedWallet();
            transactionCollision = true;

            const result = await runRefund(makeReq(CLIENT_KEY));

            assert.equal(result.statusCode, 202);
            assert.equal(result.body.requiresReconciliation, true);

            const refund = refunds[0];
            assert.equal(refund.status, "PENDING");
            assert.notEqual(refund.status, "PROCESSED");
            assert.equal(refund.requiresReconciliation, true);
            assert.equal(refund.reservationActive, true);

            assert.equal(transactions.length, 0);
            assert.equal(ledgers.length, 0);
            // Read from the arrays, not the pre-rollback object references.
            assert.equal(wallets[0].balance, INITIAL_BALANCE);
            assert.equal(payments[0].refundedAmount, 0);
        }

        console.log = originalLog;
        console.log("refund key collision tests: 4 passed");
    } finally {
        console.log = originalLog;
        console.error = originalError;
        (mongoose as any).startSession = originalStartSession;
        Razorpay.prototype.addResources = originalAddResources;
    }
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
