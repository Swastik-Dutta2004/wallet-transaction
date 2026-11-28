import assert from "node:assert/strict";
import crypto from "node:crypto";

const USER_ID = "507f1f77bcf86cd799439011";
const WALLET_ID = "507f1f77bcf86cd799439015";
const PAYMENT_ID = "507f1f77bcf86cd799439013";
const RAZORPAY_PAYMENT_ID = "pay_dispatch_race";
const IDEMPOTENCY_KEY = "dispatch-race-key";
const INITIAL_BALANCE = 50000;
const REFUND_AMOUNT_PAISE = 10000;
const WEBHOOK_SECRET = "whsec_dispatch_race";

// Patch the SDK before loading the controller, which constructs its own
// Razorpay client at module import time.
const Razorpay = require("razorpay");
const mongoose = require("mongoose");
const originalAddResources = Razorpay.prototype.addResources;

let refundImpl: (...args: any[]) => Promise<any> = async () => {
    throw new Error("refundImpl was not configured for this scenario.");
};
let fetchRefundImpl: (...args: any[]) => Promise<any>;
let fetchMultipleRefundImpl: (...args: any[]) => Promise<any>;
let razorpayRefundCalls = 0;

const fakePayments = {
    refund: async (...args: any[]) => {
        razorpayRefundCalls += 1;
        return await refundImpl(...args);
    },
    fetchRefund: async (...args: any[]) => await fetchRefundImpl(...args),
    fetchMultipleRefund: async (...args: any[]) =>
        await fetchMultipleRefundImpl(...args)
};

Razorpay.prototype.addResources = function () {
    originalAddResources.call(this);
    this.payments = fakePayments;
    this.orders = { create: async () => { throw new Error("unused"); }, all: async () => ({ items: [] }) };
};

process.env.RAZORPAY_KEY_ID = "test_key";
process.env.RAZORPAY_KEY_SECRET = "test_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { createRefund, reconcileRefund, handleWebhook } =
    require("../controllers/payment.controller");
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

function refundObjectId(n: number): string {
    return `507f1f77bcf86cd7994${String(n).padStart(5, "0")}`;
}

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

// Emulates rollback of the in-memory records touched inside withTransaction.
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

// Deliberately does not evaluate $expr/$and: the guards here are the
// dispatchClaimed/status conditions. This harness proves mock-level control
// flow, not MongoDB's expression evaluation.
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

            if ("$in" in condition &&
                !condition.$in.some((value: unknown) => actualValues.includes(String(value)))) {
                return false;
            }

            if ("$nin" in condition &&
                condition.$nin.some((value: unknown) => actualValues.includes(String(value)))) {
                return false;
            }

            // Missing fields must not satisfy { $ne: true }.
            if ("$ne" in condition && String(actual) === String(condition.$ne)) {
                return false;
            }

            if ("$exists" in condition &&
                (actual !== undefined) !== Boolean(condition.$exists)) {
                return false;
            }

            continue;
        }

        // MongoDB `{ field: null }` matches both null and missing fields.
        if (expected === null && (actual === undefined || actual === null)) {
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

(Payment as any).updateOne = async (filter: any, update: any) => {
    const payment = payments.find((candidate) => matches(candidate, filter));
    if (!payment) {
        return { matchedCount: 0 };
    }

    applyUpdate(payment, update);
    return { matchedCount: 1 };
};

(Refund as any).create = async (data: any) => {
    if (refunds.some((refund) => refund.idempotencyKey === data.idempotencyKey)) {
        throw { code: 11000 };
    }

    refundSequence += 1;
    const refund = {
        _id: refundObjectId(refundSequence),
        razorpayRefundId: undefined,
        status: "CREATED",
        reservationActive: false,
        dispatchClaimed: false,
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

// Mongoose queries return document snapshots. Cloning here is important for
// interleaving tests: a concurrent webhook must not mutate a reconciliation
// request's already-loaded `refund` object.
(Refund as any).findOne = async (filter: any) => {
    const refund = refunds.find((candidate) => matches(candidate, filter));
    return refund ? clone(refund) : null;
};

(Refund as any).findById = async (id: any) => {
    const refund = refunds.find((candidate) => String(candidate._id) === String(id));
    return refund ? clone(refund) : null;
};

(Refund as any).findOneAndUpdate = async (filter: any, update: any) => {
    const refund = refunds.find((candidate) => matches(candidate, filter));
    if (!refund) {
        return null;
    }

    applyUpdate(refund, update);
    return clone(refund);
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

(Wallet as any).updateOne = async (filter: any, update: any) => {
    const wallet = wallets.find((candidate) => matches(candidate, filter));
    if (!wallet) {
        return { matchedCount: 0 };
    }

    applyUpdate(wallet, update);
    return { matchedCount: 1 };
};

(Transaction as any).prototype.save = async function (this: any) {
    if (transactions.some((item) => item.idempotencyKey === this.idempotencyKey)) {
        throw { code: 11000 };
    }

    transactionSequence += 1;
    this._id = this._id ?? `transaction_race_${transactionSequence}`;
    transactions.push(this);
    return this;
};

(Ledger as any).prototype.save = async function (this: any) {
    ledgerSequence += 1;
    this._id = this._id ?? `ledger_race_${ledgerSequence}`;
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
    razorpayRefundCalls = 0;

    refundImpl = async () => processedRefund("rfnd_default");
    fetchRefundImpl = async () => {
        throw new Error("fetchRefund must not be called in these scenarios.");
    };
    fetchMultipleRefundImpl = async () => ({ items: [], count: 0 });
}

function processedRefund(id: string): any {
    return {
        id,
        status: "processed",
        amount: REFUND_AMOUNT_PAISE,
        currency: "INR",
        payment_id: RAZORPAY_PAYMENT_ID,
        receipt: IDEMPOTENCY_KEY
    };
}

function seedPayment(reservedRefundAmount = 0): any {
    const payment = {
        _id: PAYMENT_ID,
        userId: USER_ID,
        razorpayOrderId: "order_dispatch_race",
        razorpayPaymentId: RAZORPAY_PAYMENT_ID,
        amount: INITIAL_BALANCE,
        currency: "INR",
        refundedAmount: 0,
        reservedRefundAmount,
        status: "SUCCESS"
    };

    payments.push(payment);
    return payment;
}

function seedWallet(reservedBalance = 0): any {
    const wallet = {
        _id: WALLET_ID,
        ownerId: USER_ID,
        balance: INITIAL_BALANCE,
        reservedBalance,
        currency: "INR",
        status: "active"
    };

    wallets.push(wallet);
    return wallet;
}

function seedRefund(overrides: Record<string, unknown> = {}): any {
    refundSequence += 1;
    const refund = {
        _id: refundObjectId(refundSequence),
        userId: USER_ID,
        paymentId: PAYMENT_ID,
        razorpayPaymentId: RAZORPAY_PAYMENT_ID,
        razorpayRefundId: undefined,
        amount: REFUND_AMOUNT_PAISE,
        currency: "INR",
        status: "CREATED",
        reservationActive: true,
        dispatchClaimed: false,
        requiresReconciliation: false,
        idempotencyKey: IDEMPOTENCY_KEY,
        reason: "dispatch race",
        failureReason: undefined,
        finalizedAt: undefined,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...overrides
    };

    refunds.push(refund);
    return refund;
}

function makeReq(): any {
    return {
        user: { userId: USER_ID },
        headers: { "idempotency-key": IDEMPOTENCY_KEY },
        body: {
            paymentId: PAYMENT_ID,
            amount: 100,
            reason: "dispatch race"
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

async function runRefund() {
    const { res, result } = makeRes();
    await createRefund(makeReq(), res);
    return result;
}

async function runReconcile(refundId: string) {
    const { res, result } = makeRes();
    await reconcileRefund(
        { user: { userId: USER_ID }, params: { refundId }, headers: {}, body: {} } as any,
        res
    );
    return result;
}

async function runWebhook(refundId: string) {
    const body = {
        event: "refund.processed",
        payload: {
            refund: {
                entity: {
                    id: refundId,
                    payment_id: RAZORPAY_PAYMENT_ID,
                    amount: REFUND_AMOUNT_PAISE,
                    currency: "INR",
                    receipt: IDEMPOTENCY_KEY
                }
            }
        }
    };
    const rawBody = JSON.stringify(body);
    const signature = crypto
        .createHmac("sha256", WEBHOOK_SECRET)
        .update(rawBody)
        .digest("hex");

    const { res, result } = makeRes();
    await handleWebhook(
        {
            headers: { "x-razorpay-signature": signature },
            rawBody,
            body
        } as any,
        res
    );
    return result;
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error("Timed out waiting for the dispatch to be claimed.");
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

function assertAccounting(expected: {
    balance: number;
    reservedBalance: number;
    refundedAmount: number;
    reservedRefundAmount: number;
    refundStatus: string;
    transactionCount: number;
    ledgerCount: number;
    debitCount?: number;
}): void {
    assert.equal(wallets[0].balance, expected.balance, "wallet.balance");
    assert.equal(wallets[0].reservedBalance, expected.reservedBalance, "wallet.reservedBalance");
    assert.equal(payments[0].refundedAmount, expected.refundedAmount, "payment.refundedAmount");
    assert.equal(payments[0].reservedRefundAmount, expected.reservedRefundAmount, "payment.reservedRefundAmount");
    assert.equal(refunds[0].status, expected.refundStatus, "refund.status");
    assert.equal(transactions.length, expected.transactionCount, "transaction count");
    assert.equal(ledgers.length, expected.ledgerCount, "ledger count");

    if (expected.debitCount !== undefined) {
        assert.equal(
            transactions.filter((item) => item.type === "DEBIT").length,
            expected.debitCount,
            "DEBIT transaction count"
        );
    }
}

async function run(): Promise<void> {
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => undefined;
    console.error = () => undefined;

    try {
        // 1. Reconciliation while dispatch is in flight; original then succeeds.
        {
            reset();
            seedPayment();
            seedWallet();

            let resolveRazorpay!: (value: any) => void;
            const gate = new Promise<any>((resolve) => { resolveRazorpay = resolve; });
            const externalRefund = processedRefund("rfnd_in_flight");
            refundImpl = async () => {
                await gate;
                return externalRefund;
            };

            const { res, result } = makeRes();
            const createPromise = createRefund(makeReq(), res);
            await waitFor(() => razorpayRefundCalls === 1);

            const refundId = String(refunds[0]._id);
            const reconciliation = await runReconcile(refundId);

            assert.equal(reconciliation.statusCode, 202);
            assert.equal(reconciliation.body.requiresReconciliation, true);
            assert.equal(refunds[0].dispatchClaimed, true);
            assert.equal(refunds[0].reservationActive, true);
            assertAccounting({
                balance: INITIAL_BALANCE,
                reservedBalance: REFUND_AMOUNT_PAISE,
                refundedAmount: 0,
                reservedRefundAmount: REFUND_AMOUNT_PAISE,
                refundStatus: "PENDING",
                transactionCount: 0,
                ledgerCount: 0
            });

            resolveRazorpay(externalRefund);
            await createPromise;

            assert.equal(result.statusCode, 200);
            assert.equal(result.body.message, "Refund processed successfully.");
            assertAccounting({
                balance: INITIAL_BALANCE - REFUND_AMOUNT_PAISE,
                reservedBalance: 0,
                refundedAmount: REFUND_AMOUNT_PAISE,
                reservedRefundAmount: 0,
                refundStatus: "PROCESSED",
                transactionCount: 1,
                ledgerCount: 1,
                debitCount: 1
            });
        }

        // 2. Crash after claim: no external refund exists yet; fail closed.
        {
            reset();
            seedPayment(REFUND_AMOUNT_PAISE);
            seedWallet(REFUND_AMOUNT_PAISE);
            const refund = seedRefund({ dispatchClaimed: true });

            const result = await runReconcile(String(refund._id));

            assert.equal(result.statusCode, 202);
            assert.equal(result.body.requiresReconciliation, true);
            assert.equal(refunds[0].reservationActive, true);
            assert.equal(refunds[0].requiresReconciliation, true);
            assert.notEqual(refunds[0].status, "FAILED");
            assertAccounting({
                balance: INITIAL_BALANCE,
                reservedBalance: REFUND_AMOUNT_PAISE,
                refundedAmount: 0,
                reservedRefundAmount: REFUND_AMOUNT_PAISE,
                refundStatus: "PENDING",
                transactionCount: 0,
                ledgerCount: 0
            });
        }

        // 3. Genuine gap: reserved but dispatch never claimed -> safe release.
        //    A later same-key request must not dispatch after that release.
        {
            reset();
            seedPayment(REFUND_AMOUNT_PAISE);
            seedWallet(REFUND_AMOUNT_PAISE);
            const refund = seedRefund({ dispatchClaimed: false });

            const result = await runReconcile(String(refund._id));

            assert.equal(refunds[0].status, "FAILED");
            assert.equal(refunds[0].reservationActive, false);
            assertAccounting({
                balance: INITIAL_BALANCE,
                reservedBalance: 0,
                refundedAmount: 0,
                reservedRefundAmount: 0,
                refundStatus: "FAILED",
                transactionCount: 0,
                ledgerCount: 0
            });

            const replay = await runRefund();
            assert.equal(replay.statusCode, 200);
            assert.equal(replay.body.message, "Request already processed.");
            assert.equal(razorpayRefundCalls, 0);
        }

        // 4. Definitive Razorpay rejection releases safely despite the claim.
        {
            reset();
            seedPayment();
            seedWallet();
            refundImpl = async () => {
                throw {
                    statusCode: 400,
                    error: {
                        code: "BAD_REQUEST_ERROR",
                        description: "refund amount provided is greater than amount captured"
                    }
                };
            };

            const result = await runRefund();

            assert.equal(result.statusCode, 200);
            assert.equal(result.body.message, "Refund failed.");
            assert.equal(refunds[0].dispatchClaimed, true);
            assertAccounting({
                balance: INITIAL_BALANCE,
                reservedBalance: 0,
                refundedAmount: 0,
                reservedRefundAmount: 0,
                refundStatus: "FAILED",
                transactionCount: 0,
                ledgerCount: 0
            });
        }

        // 5. Webhook during reconciliation finalizes once; the original
        //    request completing afterwards must not debit a second time.
        {
            reset();
            seedPayment();
            seedWallet();

            let resolveRazorpay!: (value: any) => void;
            const gate = new Promise<any>((resolve) => { resolveRazorpay = resolve; });
            const webhookRefundId = "rfnd_webhook_claim";
            const externalRefund = processedRefund(webhookRefundId);
            refundImpl = async () => {
                await gate;
                return externalRefund;
            };

            const { res, result } = makeRes();
            const createPromise = createRefund(makeReq(), res);
            await waitFor(() => razorpayRefundCalls === 1);

            const refundId = String(refunds[0]._id);
            await runReconcile(refundId);

            const webhookResult = await runWebhook(webhookRefundId);

            assert.equal(webhookResult.statusCode, 200);
            assertAccounting({
                balance: INITIAL_BALANCE - REFUND_AMOUNT_PAISE,
                reservedBalance: 0,
                refundedAmount: REFUND_AMOUNT_PAISE,
                reservedRefundAmount: 0,
                refundStatus: "PROCESSED",
                transactionCount: 1,
                ledgerCount: 1,
                debitCount: 1
            });

            resolveRazorpay(externalRefund);
            await createPromise;

            assertAccounting({
                balance: INITIAL_BALANCE - REFUND_AMOUNT_PAISE,
                reservedBalance: 0,
                refundedAmount: REFUND_AMOUNT_PAISE,
                reservedRefundAmount: 0,
                refundStatus: "PROCESSED",
                transactionCount: 1,
                ledgerCount: 1,
                debitCount: 1
            });
        }

        // 6. Duplicate reconciliation calls must not release or debit twice.
        {
            reset();
            seedPayment(REFUND_AMOUNT_PAISE);
            seedWallet(REFUND_AMOUNT_PAISE);
            const refund = seedRefund({ dispatchClaimed: true });

            const first = await runReconcile(String(refund._id));
            const second = await runReconcile(String(refund._id));

            assert.equal(first.statusCode, 202);
            assert.equal(second.statusCode, 202);
            assert.equal(refunds[0].status, "PENDING");
            assertAccounting({
                balance: INITIAL_BALANCE,
                reservedBalance: REFUND_AMOUNT_PAISE,
                refundedAmount: 0,
                reservedRefundAmount: REFUND_AMOUNT_PAISE,
                refundStatus: "PENDING",
                transactionCount: 0,
                ledgerCount: 0
            });
        }

        // 7. Legacy row with no dispatchClaimed field fails closed.
        {
            reset();
            seedPayment(REFUND_AMOUNT_PAISE);
            seedWallet(REFUND_AMOUNT_PAISE);
            const legacy = seedRefund();
            delete (legacy as any).dispatchClaimed;

            const result = await runReconcile(String(legacy._id));

            assert.equal(result.statusCode, 202);
            assert.equal(refunds[0].reservationActive, true);
            assert.equal(refunds[0].requiresReconciliation, true);
            assert.notEqual(refunds[0].status, "FAILED");
            assertAccounting({
                balance: INITIAL_BALANCE,
                reservedBalance: REFUND_AMOUNT_PAISE,
                refundedAmount: 0,
                reservedRefundAmount: REFUND_AMOUNT_PAISE,
                refundStatus: "PENDING",
                transactionCount: 0,
                ledgerCount: 0
            });
        }

        // 8. Ambiguous dispatch outcome stays reserved and is recoverable
        //    when reconciliation later finds the external refund by receipt.
        {
            reset();
            seedPayment();
            seedWallet();
            refundImpl = async () => {
                throw new Error("network timeout");
            };

            const ambiguous = await runRefund();

            assert.equal(ambiguous.statusCode, 202);
            assert.equal(refunds[0].status, "PENDING");
            assert.equal(refunds[0].requiresReconciliation, true);
            assert.equal(refunds[0].dispatchClaimed, true);
            assertAccounting({
                balance: INITIAL_BALANCE,
                reservedBalance: REFUND_AMOUNT_PAISE,
                refundedAmount: 0,
                reservedRefundAmount: REFUND_AMOUNT_PAISE,
                refundStatus: "PENDING",
                transactionCount: 0,
                ledgerCount: 0
            });

            fetchMultipleRefundImpl = async () => ({
                items: [processedRefund("rfnd_recovered")],
                count: 1
            });

            const recovered = await runReconcile(String(refunds[0]._id));

            assert.equal(recovered.statusCode, 200);
            assertAccounting({
                balance: INITIAL_BALANCE - REFUND_AMOUNT_PAISE,
                reservedBalance: 0,
                refundedAmount: REFUND_AMOUNT_PAISE,
                reservedRefundAmount: 0,
                refundStatus: "PROCESSED",
                transactionCount: 1,
                ledgerCount: 1,
                debitCount: 1
            });
        }

        // 9. Webhook finalizes while reconciliation's Razorpay lookup is in
        //    flight; reconciliation must not report or leave a second debit.
        {
            reset();
            seedPayment(REFUND_AMOUNT_PAISE);
            seedWallet(REFUND_AMOUNT_PAISE);
            const refund = seedRefund({ dispatchClaimed: true });

            let resolveFetch!: (value: any) => void;
            const fetchGate = new Promise<any>((resolve) => { resolveFetch = resolve; });
            let fetchCalls = 0;
            fetchMultipleRefundImpl = async () => {
                fetchCalls += 1;
                await fetchGate;
                return { items: [], count: 0 };
            };

            const reconcilePromise = runReconcile(String(refund._id));
            await waitFor(() => fetchCalls === 1);

            const webhookResult = await runWebhook("rfnd_webhook_race");

            resolveFetch({ items: [], count: 0 });
            const reconcileResult = await reconcilePromise;

            assert.equal(webhookResult.statusCode, 200);
            assert.equal(reconcileResult.statusCode, 200);
            assertAccounting({
                balance: INITIAL_BALANCE - REFUND_AMOUNT_PAISE,
                reservedBalance: 0,
                refundedAmount: REFUND_AMOUNT_PAISE,
                reservedRefundAmount: 0,
                refundStatus: "PROCESSED",
                transactionCount: 1,
                ledgerCount: 1,
                debitCount: 1
            });
        }

        console.log = originalLog;
        console.log("refund dispatch race tests: 9 passed");
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
