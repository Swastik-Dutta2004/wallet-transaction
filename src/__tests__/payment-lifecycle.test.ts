import assert from "node:assert/strict";
import crypto from "node:crypto";

const USER_ID = "507f1f77bcf86cd799439011";
const ORDER_DB_ID = "507f1f77bcf86cd799439014";
const ORDER_ID = "order_lifecycle_test";
const WALLET_ID = "507f1f77bcf86cd799439015";
const IDEMPOTENCY_KEY = "lifecycle-key";
const AMOUNT_PAISE = 50000;
const INITIAL_BALANCE = 100000;
const FAILED_PAYMENT_ID = "pay_failed_attempt";
const SUCCESS_PAYMENT_ID = "pay_success_attempt";
const WEBHOOK_SECRET = "test_webhook_secret";
const CHECKOUT_SECRET = "test_checkout_secret";

// Patch the SDK before loading the controller, which constructs its own
// Razorpay client at module import time.
const Razorpay = require("razorpay");
const mongoose = require("mongoose");
const originalAddResources = Razorpay.prototype.addResources;

const fakeOrders = {
    create: async (params: any) => ({
        id: "order_unused",
        amount: params.amount,
        currency: params.currency,
        receipt: params.receipt,
        status: "created"
    }),
    all: async () => ({ items: [] }),
    fetch: async (id: any) => ({
        id,
        amount: AMOUNT_PAISE,
        currency: "INR",
        status: "created"
    })
};

Razorpay.prototype.addResources = function () {
    originalAddResources.call(this);
    this.orders = fakeOrders;
};

process.env.RAZORPAY_KEY_ID = "test_key";
process.env.RAZORPAY_KEY_SECRET = CHECKOUT_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { handleWebhook, verifyPayment } = require("../controllers/payment.controller");
const PaymentOrder = require("../models/payment-order.models").default;
const Payment = require("../models/payment.models").default;
const Wallet = require("../models/wallet.models").default;
const Transaction = require("../models/transaction.models").default;
const Ledger = require("../models/ledger.models").default;

type OrderStatus = "CREATED" | "PAID" | "FAILED";

type FakeOrder = {
    _id: string;
    userId: string;
    razorpayOrderId: string;
    amount: number;
    currency: string;
    idempotencyKey: string;
    status: OrderStatus;
    failedPaymentIds?: string[];
    createdAt: Date;
    updatedAt: Date;
    markModified?: (field: string) => void;
    save?: () => Promise<FakeOrder>;
};

type FakeWallet = {
    _id: string;
    ownerId: string;
    balance: number;
    reservedBalance: number;
    currency: string;
    status: string;
};

type FakePayment = {
    _id?: string;
    userId: string;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature?: string;
    amount: number;
    currency: string;
    refundedAmount: number;
    reservedRefundAmount: number;
    status: string;
};

type FakeTransaction = {
    _id?: string;
    walletId: string;
    type: string;
    amount: number;
    currency: string;
    status: string;
    idempotencyKey: string;
    description?: string;
};

type FakeLedger = {
    _id?: string;
    walletId: string;
    transactionId: string;
    type: string;
    amount: number;
    balanceBefore: number;
    balanceAfter: number;
    currency: string;
    description?: string;
};

let orders: FakeOrder[] = [];
let wallets: FakeWallet[] = [];
let payments: FakePayment[] = [];
let transactions: FakeTransaction[] = [];
let ledgers: FakeLedger[] = [];

const fakeSession = {
    withTransaction: async (fn: () => Promise<void>) => await fn(),
    inTransaction: () => false,
    abortTransaction: async () => undefined,
    endSession: async () => undefined
};

const originalStartSession = mongoose.startSession;
(mongoose as any).startSession = async () => fakeSession;

function query<T>(value: T): any {
    const promise = Promise.resolve(value);
    const result: any = {
        session() {
            return result;
        },
        limit() {
            return result;
        },
        then(onFulfilled?: any, onRejected?: any) {
            return promise.then(onFulfilled, onRejected);
        },
        catch(onRejected?: any) {
            return promise.catch(onRejected);
        },
        finally(onFinally?: any) {
            return promise.finally(onFinally);
        }
    };

    return result;
}

function matches(doc: any, filter: any): boolean {
    for (const [field, expected] of Object.entries(filter ?? {})) {
        const actual = doc?.[field];

        const isObjectId =
            expected !== null &&
            typeof expected === "object" &&
            "_bsontype" in (expected as Record<string, unknown>);

        if (
            expected !== null &&
            typeof expected === "object" &&
            !Array.isArray(expected) &&
            !(expected instanceof Date) &&
            !isObjectId
        ) {
            const condition = expected as Record<string, any>;
            const actualValues = Array.isArray(actual)
                ? actual.map((value: unknown) => String(value))
                : [String(actual)];

            if (
                "$in" in condition &&
                !condition.$in.some((value: unknown) =>
                    actualValues.includes(String(value))
                )
            ) {
                return false;
            }

            if (
                "$nin" in condition &&
                condition.$nin.some((value: unknown) =>
                    actualValues.includes(String(value))
                )
            ) {
                return false;
            }

            if (
                "$exists" in condition &&
                (actual !== undefined) !== Boolean(condition.$exists)
            ) {
                return false;
            }

            const supported = ["$in", "$nin", "$exists"];
            if (
                Object.keys(condition).some(
                    (operator) => !supported.includes(operator)
                )
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

        const values = Array.isArray((value as any)?.$each)
            ? (value as any).$each
            : [value];

        for (const item of values) {
            if (!doc[field].some((existing: unknown) =>
                String(existing) === String(item)
            )) {
                doc[field].push(item);
            }
        }
    }

    doc.updatedAt = new Date();
}

(PaymentOrder as any).findOne = async (filter: any) =>
    query(orders.find((order) => matches(order, filter)) ?? null);

(PaymentOrder as any).findById = (id: any) =>
    query(orders.find((order) => String(order._id) === String(id)) ?? null);

(PaymentOrder as any).findOneAndUpdate = async (
    filter: any,
    update: any
) => {
    const order = orders.find((candidate) => matches(candidate, filter));
    if (!order) {
        return null;
    }

    applyUpdate(order, update);
    return order;
};

(PaymentOrder as any).updateOne = async (filter: any, update: any) => {
    const order = orders.find((candidate) => matches(candidate, filter));
    if (!order) {
        return { matchedCount: 0 };
    }

    applyUpdate(order, update);
    return { matchedCount: 1 };
};

(Payment as any).findOne = (filter: any) =>
    query(payments.find((payment) => matches(payment, filter)) ?? null);

(Payment as any).prototype.save = async function (this: any) {
    if (!this._id) {
        this._id = `payment-${payments.length + 1}`;
    }
    payments.push(this);
    return this;
};

(Wallet as any).findOne = (filter: any) =>
    query(wallets.find((wallet) => matches(wallet, filter)) ?? null);

(Wallet as any).findOneAndUpdate = async (filter: any, update: any) => {
    const wallet = wallets.find((candidate) => matches(candidate, filter));
    if (!wallet) {
        return null;
    }

    applyUpdate(wallet, update);
    return wallet;
};

(Transaction as any).findOne = (filter: any) =>
    query(transactions.find((transaction) => matches(transaction, filter)) ?? null);

(Transaction as any).prototype.save = async function (this: any) {
    if (!this._id) {
        this._id = `transaction-${transactions.length + 1}`;
    }
    transactions.push(this);
    return this;
};

(Ledger as any).find = (filter: any) =>
    query(ledgers.filter((ledger) => matches(ledger, filter)));

(Ledger as any).prototype.save = async function (this: any) {
    if (!this._id) {
        this._id = `ledger-${ledgers.length + 1}`;
    }
    ledgers.push(this);
    return this;
};

function reset(): void {
    orders = [];
    wallets = [];
    payments = [];
    transactions = [];
    ledgers = [];
}

function seedOrder(
    status: OrderStatus = "CREATED",
    failedPaymentIds: string[] = []
): FakeOrder {
    const order: FakeOrder = {
        _id: ORDER_DB_ID,
        userId: USER_ID,
        razorpayOrderId: ORDER_ID,
        amount: AMOUNT_PAISE,
        currency: "INR",
        idempotencyKey: IDEMPOTENCY_KEY,
        status,
        failedPaymentIds,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z")
    };

    order.markModified = () => undefined;
    order.save = async () => order;
    orders.push(order);
    return order;
}

function seedWallet(): FakeWallet {
    const wallet: FakeWallet = {
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

function failedEntity() {
    return {
        id: FAILED_PAYMENT_ID,
        order_id: ORDER_ID,
        amount: AMOUNT_PAISE,
        currency: "INR"
    };
}

function capturedEntity(overrides: Record<string, unknown> = {}) {
    return {
        id: SUCCESS_PAYMENT_ID,
        order_id: ORDER_ID,
        amount: AMOUNT_PAISE,
        currency: "INR",
        ...overrides
    };
}

function makeWebhookReq(
    event: string,
    entity: any,
    tamperSignature = false
): any {
    const body = {
        event,
        payload: {
            payment: { entity }
        }
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = crypto
        .createHmac("sha256", WEBHOOK_SECRET)
        .update(rawBody)
        .digest("hex");

    return {
        body,
        rawBody,
        headers: {
            "x-razorpay-signature": tamperSignature
                ? "0".repeat(signature.length)
                : signature
        }
    };
}

function makeCheckoutReq(paymentId: string): any {
    const body = `${ORDER_ID}|${paymentId}`;
    const signature = crypto
        .createHmac("sha256", CHECKOUT_SECRET)
        .update(body)
        .digest("hex");

    return {
        user: { userId: USER_ID },
        body: {
            razorpay_order_id: ORDER_ID,
            razorpay_payment_id: paymentId,
            razorpay_signature: signature
        },
        headers: {},
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

async function runFailedThenCapture() {
    const order = seedOrder("CREATED");
    const wallet = seedWallet();

    const failedRes = makeRes();
    await handleWebhook(
        makeWebhookReq("payment.failed", failedEntity()),
        failedRes.res
    );
    const statusAfterFailed = order.status;
    const failedIdsAfterFailed = [...(order.failedPaymentIds ?? [])];

    const capturedRes = makeRes();
    await handleWebhook(
        makeWebhookReq("payment.captured", capturedEntity()),
        capturedRes.res
    );

    return {
        order,
        wallet,
        failedRes,
        capturedRes,
        statusAfterFailed,
        failedIdsAfterFailed
    };
}

async function run(): Promise<void> {
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => undefined;
    console.error = () => undefined;

    try {
        // 1. A failed attempt must not block a later successful capture.
        {
            reset();

            const {
                order,
                wallet,
                failedRes,
                capturedRes,
                statusAfterFailed,
                failedIdsAfterFailed
            } = await runFailedThenCapture();

            assert.equal(failedRes.result.statusCode, 200);
            assert.equal(statusAfterFailed, "FAILED");
            assert.deepEqual(failedIdsAfterFailed, [FAILED_PAYMENT_ID]);

            assert.equal(capturedRes.result.statusCode, 200);
            assert.equal(order.status, "PAID");
            assert.equal(wallet.balance, INITIAL_BALANCE + AMOUNT_PAISE);
            assert.equal(payments.length, 1);
            assert.equal(payments[0].razorpayPaymentId, SUCCESS_PAYMENT_ID);
            assert.equal(transactions.length, 1);
            assert.equal(transactions[0].type, "CREDIT");
            assert.equal(ledgers.length, 1);
            assert.equal(ledgers[0].type, "CREDIT");
        }

        // 2. Duplicate capture webhooks and Checkout verification must not
        //    double-credit after the successful recovery.
        {
            reset();

            const { wallet } = await runFailedThenCapture();
            const balanceAfterCapture = wallet.balance;

            const duplicateRes = makeRes();
            await handleWebhook(
                makeWebhookReq("payment.captured", capturedEntity()),
                duplicateRes.res
            );

            assert.equal(duplicateRes.result.statusCode, 200);
            assert.equal(
                duplicateRes.result.body.message,
                "Payment already processed."
            );

            const checkoutRes = makeRes();
            await verifyPayment(
                makeCheckoutReq(SUCCESS_PAYMENT_ID),
                checkoutRes.res
            );

            assert.equal(checkoutRes.result.statusCode, 200);
            assert.equal(
                checkoutRes.result.body.message,
                "Payment already processed."
            );

            assert.equal(wallet.balance, balanceAfterCapture);
            assert.equal(payments.length, 1);
            assert.equal(transactions.length, 1);
            assert.equal(ledgers.length, 1);
        }

        // 3. Checkout verification must also be able to recover a FAILED order
        //    when a different payment is verified.
        {
            reset();

            const order = seedOrder("CREATED");
            const wallet = seedWallet();

            const failedRes = makeRes();
            await handleWebhook(
                makeWebhookReq("payment.failed", failedEntity()),
                failedRes.res
            );

            assert.equal(failedRes.result.statusCode, 200);
            assert.equal(order.status, "FAILED");

            const checkoutRes = makeRes();
            await verifyPayment(
                makeCheckoutReq(SUCCESS_PAYMENT_ID),
                checkoutRes.res
            );

            assert.equal(checkoutRes.result.statusCode, 200);
            assert.equal(
                checkoutRes.result.body.message,
                "Payment verified and wallet credited successfully."
            );
            assert.equal(order.status, "PAID");
            assert.equal(wallet.balance, INITIAL_BALANCE + AMOUNT_PAISE);
            assert.equal(payments.length, 1);
            assert.equal(transactions.length, 1);
            assert.equal(ledgers.length, 1);
        }

        // 4. Recovery evidence must not bypass amount validation.
        {
            reset();

            const order = seedOrder("FAILED", [FAILED_PAYMENT_ID]);
            const wallet = seedWallet();

            const response = makeRes();
            await handleWebhook(
                makeWebhookReq(
                    "payment.captured",
                    capturedEntity({ amount: AMOUNT_PAISE + 1 })
                ),
                response.res
            );

            assert.equal(response.result.statusCode, 400);
            assert.equal(
                response.result.body.message,
                "Payment amount does not match the order."
            );
            assert.equal(order.status, "FAILED");
            assert.equal(wallet.balance, INITIAL_BALANCE);
            assert.equal(payments.length, 0);
            assert.equal(transactions.length, 0);
            assert.equal(ledgers.length, 0);
        }

        // 5. Recovery evidence must not bypass webhook signature validation.
        {
            reset();

            const order = seedOrder("FAILED", [FAILED_PAYMENT_ID]);
            const wallet = seedWallet();

            const response = makeRes();
            await handleWebhook(
                makeWebhookReq(
                    "payment.captured",
                    capturedEntity(),
                    true
                ),
                response.res
            );

            assert.equal(response.result.statusCode, 400);
            assert.equal(
                response.result.body.message,
                "Invalid webhook signature."
            );
            assert.equal(order.status, "FAILED");
            assert.equal(wallet.balance, INITIAL_BALANCE);
            assert.equal(payments.length, 0);
            assert.equal(transactions.length, 0);
            assert.equal(ledgers.length, 0);
        }

        // 6. Legacy FAILED orders without attempt evidence stay terminal.
        {
            reset();

            const order = seedOrder("FAILED", []);
            const wallet = seedWallet();

            const response = makeRes();
            await handleWebhook(
                makeWebhookReq("payment.captured", capturedEntity()),
                response.res
            );

            assert.equal(response.result.statusCode, 409);
            assert.equal(
                response.result.body.message,
                "Payment state conflicts with the webhook."
            );
            assert.equal(order.status, "FAILED");
            assert.equal(wallet.balance, INITIAL_BALANCE);
            assert.equal(payments.length, 0);
            assert.equal(transactions.length, 0);
            assert.equal(ledgers.length, 0);
        }

        // 7. The same payment ID that failed cannot later recover the order.
        {
            reset();

            const order = seedOrder("FAILED", [FAILED_PAYMENT_ID]);
            const wallet = seedWallet();

            const response = makeRes();
            await handleWebhook(
                makeWebhookReq(
                    "payment.captured",
                    capturedEntity({ id: FAILED_PAYMENT_ID })
                ),
                response.res
            );

            assert.equal(response.result.statusCode, 409);
            assert.equal(order.status, "FAILED");
            assert.equal(wallet.balance, INITIAL_BALANCE);
            assert.equal(payments.length, 0);
            assert.equal(transactions.length, 0);
            assert.equal(ledgers.length, 0);
        }

        console.log = originalLog;
        console.log("payment lifecycle regression tests: 7 passed");
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
