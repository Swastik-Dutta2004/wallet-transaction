import assert from "node:assert/strict";

// Patch the SDK before loading the controller, which constructs its own
// Razorpay client at module import time.
const Razorpay = require("razorpay");
const mongoose = require("mongoose");
const originalAddResources = Razorpay.prototype.addResources;

let razorpayRefundCalls = 0;

const fakeOrders = {
    create: async (params: any) => ({
        id: "order_unused",
        amount: params.amount,
        currency: params.currency,
        receipt: params.receipt,
        status: "created"
    }),
    all: async () => ({ items: [] })
};

const fakePayments = {
    refund: async () => {
        razorpayRefundCalls += 1;
        throw new Error("Razorpay refund must not be called in these tests.");
    }
};

Razorpay.prototype.addResources = function () {
    originalAddResources.call(this);
    this.orders = fakeOrders;
    this.payments = fakePayments;
};

process.env.RAZORPAY_KEY_ID = "test_key";
process.env.RAZORPAY_KEY_SECRET = "test_secret";

const { createRefund } = require("../controllers/payment.controller");
const Payment = require("../models/payment.models").default;
const Refund = require("../models/refund.models").default;
const Wallet = require("../models/wallet.models").default;

const USER_ID = "507f1f77bcf86cd799439011";
const PAYMENT_ID = "507f1f77bcf86cd799439013";
const RAZORPAY_PAYMENT_ID = "pay_test_payment";
const IDEMPOTENCY_KEY = "refund-regression-key";
const REFUND_AMOUNT_PAISE = 10000;

type UpdateCall = {
    filter: any;
    update: any;
    options?: any;
};

let refundCreateImpl: (data: any) => Promise<any>;
let refundFindOneImpl: (filter: any) => Promise<any>;
let refundFindOneAndUpdateImpl: (
    filter: any,
    update: any,
    options?: any
) => Promise<any>;
let refundUpdateOneImpl: (
    filter: any,
    update: any,
    options?: any
) => Promise<any>;
let paymentFindByIdImpl: (id: any) => Promise<any>;
let paymentFindOneAndUpdateImpl: (
    filter: any,
    update: any,
    options?: any
) => Promise<any>;
let walletFindOneAndUpdateImpl: (
    filter: any,
    update: any,
    options?: any
) => Promise<any>;

let refundFindOneCalls: any[] = [];
let refundUpdateOneCalls: UpdateCall[] = [];
let paymentFindOneAndUpdateCalls: UpdateCall[] = [];
let walletCalls = 0;
let sessionEndCalls = 0;
let sessionAbortCalls = 0;

const fakeSession = {
    withTransaction: async (fn: () => Promise<void>) => await fn(),
    inTransaction: () => false,
    abortTransaction: async () => {
        sessionAbortCalls += 1;
    },
    endSession: async () => {
        sessionEndCalls += 1;
    }
};

const originalStartSession = mongoose.startSession;
(mongoose as any).startSession = async () => fakeSession;

function makePaymentDoc() {
    return {
        _id: PAYMENT_ID,
        userId: USER_ID,
        razorpayOrderId: "order_test_payment",
        razorpayPaymentId: RAZORPAY_PAYMENT_ID,
        razorpaySignature: undefined,
        amount: 50000,
        currency: "INR",
        refundedAmount: 0,
        reservedRefundAmount: 0,
        status: "SUCCESS",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z")
    };
}

function makeRefundDoc(overrides: Record<string, unknown> = {}) {
    return {
        _id: "refund-1",
        userId: USER_ID,
        paymentId: PAYMENT_ID,
        razorpayPaymentId: RAZORPAY_PAYMENT_ID,
        razorpayRefundId: undefined,
        amount: REFUND_AMOUNT_PAISE,
        currency: "INR",
        status: "CREATED",
        reservationActive: false,
        requiresReconciliation: false,
        idempotencyKey: IDEMPOTENCY_KEY,
        reason: "regression test",
        failureReason: undefined,
        finalizedAt: undefined,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...overrides
    };
}

(Payment as any).findById = async (id: any) => await paymentFindByIdImpl(id);

(Payment as any).findOneAndUpdate = async (
    filter: any,
    update: any,
    options?: any
) => await paymentFindOneAndUpdateImpl(filter, update, options);

(Refund as any).create = async (data: any) => await refundCreateImpl(data);

(Refund as any).findOne = async (filter: any) => {
    refundFindOneCalls.push(filter);
    return await refundFindOneImpl(filter);
};

(Refund as any).findOneAndUpdate = async (
    filter: any,
    update: any,
    options?: any
) => await refundFindOneAndUpdateImpl(filter, update, options);

(Refund as any).updateOne = async (
    filter: any,
    update: any,
    options?: any
) => {
    refundUpdateOneCalls.push({ filter, update, options });
    return await refundUpdateOneImpl(filter, update, options);
};

(Refund as any).findById = async () => null;

(Wallet as any).findOneAndUpdate = async (
    filter: any,
    update: any,
    options?: any
) => {
    walletCalls += 1;
    return await walletFindOneAndUpdateImpl(filter, update, options);
};

function reset(): void {
    refundCreateImpl = async () => makeRefundDoc();
    refundFindOneImpl = async () => null;
    refundFindOneAndUpdateImpl = async (_filter: any, update: any) =>
        makeRefundDoc({
            reservationActive: true,
            ...(update?.$set ?? {})
        });
    refundUpdateOneImpl = async () => ({ matchedCount: 1 });
    paymentFindByIdImpl = async () => makePaymentDoc();
    paymentFindOneAndUpdateImpl = async () => null;
    walletFindOneAndUpdateImpl = async () => {
        throw new Error("Wallet reservation must not be reached in these tests.");
    };

    refundFindOneCalls = [];
    refundUpdateOneCalls = [];
    paymentFindOneAndUpdateCalls = [];
    walletCalls = 0;
    razorpayRefundCalls = 0;
    sessionEndCalls = 0;
    sessionAbortCalls = 0;
}

function makeReq() {
    return {
        user: { userId: USER_ID },
        headers: { "idempotency-key": IDEMPOTENCY_KEY },
        body: {
            paymentId: PAYMENT_ID,
            amount: 100,
            reason: "regression test"
        },
        params: {}
    } as any;
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

async function run(): Promise<void> {
    try {
        // 1. Issue 2: E11000 with no readable refund row returns a controlled
        //    503 and never reaches Razorpay.
        {
            reset();
            refundCreateImpl = async () => {
                throw { code: 11000 };
            };
            refundFindOneImpl = async () => null;

            const response = makeRes();
            await createRefund(makeReq(), response.res);

            assert.equal(response.result.statusCode, 503);
            assert.deepEqual(response.result.body, {
                message: "Refund request is unresolved; retry later.",
                requiresReconciliation: true
            });
            assert.equal(razorpayRefundCalls, 0);
            assert.equal(refundFindOneCalls.length, 1);
            assert.equal(
                refundFindOneCalls[0].idempotencyKey,
                IDEMPOTENCY_KEY
            );
        }

        // 2. Issue 2 companion: E11000 with a readable refund row uses normal
        //    replay handling instead of the unresolved 503.
        {
            reset();
            refundCreateImpl = async () => {
                throw { code: 11000 };
            };
            refundFindOneImpl = async () =>
                makeRefundDoc({
                    status: "PENDING",
                    reservationActive: true
                });

            const response = makeRes();
            await createRefund(makeReq(), response.res);

            assert.equal(response.result.statusCode, 202);
            assert.equal(
                response.result.body.message,
                "Refund is still being processed."
            );
            assert.equal(response.result.body.refund.status, "PENDING");
            assert.equal(razorpayRefundCalls, 0);
        }

        // 3. Issue 4: payment reservation failure sets finalizedAt in the same
        //    conditional FAILED transition and returns 409.
        {
            reset();
            refundCreateImpl = async () => makeRefundDoc();
            paymentFindOneAndUpdateImpl = async (
                filter: any,
                update: any,
                options?: any
            ) => {
                paymentFindOneAndUpdateCalls.push({ filter, update, options });
                return null;
            };

            const originalConsoleError = console.error;
            console.error = () => undefined;

            try {
                const response = makeRes();
                await createRefund(makeReq(), response.res);

                assert.equal(response.result.statusCode, 409);
                assert.equal(
                    response.result.body.message,
                    "Refund exceeds the remaining refundable amount."
                );
                assert.equal(razorpayRefundCalls, 0);
                assert.equal(walletCalls, 0);

                assert.equal(paymentFindOneAndUpdateCalls.length, 1);
                assert.ok(paymentFindOneAndUpdateCalls[0].filter.$expr);
                assert.equal(
                    paymentFindOneAndUpdateCalls[0].update.$inc
                        .reservedRefundAmount,
                    REFUND_AMOUNT_PAISE
                );

                const failedUpdates = refundUpdateOneCalls.filter(
                    (call) => call.update?.$set?.status === "FAILED"
                );
                assert.equal(failedUpdates.length, 1);

                assert.deepEqual(failedUpdates[0].filter, {
                    _id: "refund-1",
                    status: "CREATED",
                    reservationActive: false
                });

                const set = failedUpdates[0].update.$set;
                assert.equal(set.status, "FAILED");
                assert.equal(set.requiresReconciliation, false);
                assert.equal(
                    set.failureReason,
                    "Refund exceeds the remaining refundable amount."
                );
                assert.ok(set.finalizedAt instanceof Date);
                assert.ok(!Number.isNaN(set.finalizedAt.getTime()));

                assert.equal(sessionAbortCalls, 0);
                assert.equal(sessionEndCalls, 1);
            } finally {
                console.error = originalConsoleError;
            }
        }

        console.log("refund regression tests: 3 passed");
    } finally {
        (mongoose as any).startSession = originalStartSession;
    }
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
