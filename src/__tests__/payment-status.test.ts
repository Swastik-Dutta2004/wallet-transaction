import assert from "node:assert/strict";

// Patch the SDK before loading the controller, which constructs its own
// Razorpay client at module import time.
const Razorpay = require("razorpay");
const originalAddResources = Razorpay.prototype.addResources;

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

Razorpay.prototype.addResources = function () {
    originalAddResources.call(this);
    this.orders = fakeOrders;
};

process.env.RAZORPAY_KEY_ID = "test_key";
process.env.RAZORPAY_KEY_SECRET = "test_secret";

const { getPaymentStatus } = require("../controllers/payment.controller");
const PaymentOrder = require("../models/payment-order.models").default;

const USER_ID = "507f1f77bcf86cd799439011";
const OTHER_USER_ID = "507f1f77bcf86cd799439012";
const ORDER_ID = "order_status_test";

type PaymentOrderStatus = "CREATED" | "PAID" | "FAILED";

type FakePaymentOrder = {
    _id: string;
    userId: string;
    razorpayOrderId: string;
    amount: number;
    currency: string;
    status: PaymentOrderStatus;
    createdAt: Date;
    updatedAt: Date;
};

let findOneImpl: (filter: any) => Promise<FakePaymentOrder | null> =
    async () => null;
let findOneCalls = 0;
let lastFilter: any = null;

(PaymentOrder as any).findOne = async (filter: any) => {
    findOneCalls += 1;
    lastFilter = filter;
    return await findOneImpl(filter);
};

function reset(): void {
    findOneImpl = async () => null;
    findOneCalls = 0;
    lastFilter = null;
}

function seedPaymentOrder(
    status: PaymentOrderStatus,
    razorpayOrderId: string = ORDER_ID
): FakePaymentOrder {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const updatedAt = new Date("2026-01-02T00:00:00.000Z");

    const doc: FakePaymentOrder = {
        _id: "payment-order-1",
        userId: USER_ID,
        razorpayOrderId,
        amount: 500,
        currency: "INR",
        status,
        createdAt,
        updatedAt
    };

    findOneImpl = async () => doc;
    return doc;
}

function makeReq(
    params: Record<string, string> = { orderId: ORDER_ID },
    user?: { userId?: string }
): any {
    return {
        user,
        params,
        headers: {},
        body: {}
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

async function run(): Promise<void> {
    try {
        // 1. Unauthenticated request returns 401.
        {
            reset();

            const response = makeRes();
            await getPaymentStatus(makeReq(), response.res);

            assert.equal(response.result.statusCode, 401);
            assert.equal(response.result.body.message, "User is not authenticated.");
            assert.equal(findOneCalls, 0);
        }

        // 2. Missing authenticated user ID returns 401.
        {
            reset();

            const response = makeRes();
            await getPaymentStatus(makeReq({ orderId: ORDER_ID }, {}), response.res);

            assert.equal(response.result.statusCode, 401);
            assert.equal(response.result.body.message, "User is not authenticated.");
            assert.equal(findOneCalls, 0);
        }

        // 3. Another user's order returns 404 because ownership is part of the
        //    database filter.
        {
            reset();
            findOneImpl = async () => null;

            const response = makeRes();
            await getPaymentStatus(
                makeReq({ orderId: ORDER_ID }, { userId: OTHER_USER_ID }),
                response.res
            );

            assert.equal(response.result.statusCode, 404);
            assert.equal(response.result.body.message, "Payment order not found.");
            assert.equal(findOneCalls, 1);
            assert.equal(lastFilter.razorpayOrderId, ORDER_ID);
            assert.equal(lastFilter.userId, OTHER_USER_ID);
        }

        // 4. Unknown order ID returns 404.
        {
            reset();
            findOneImpl = async () => null;

            const response = makeRes();
            await getPaymentStatus(
                makeReq({ orderId: "order_does_not_exist" }, { userId: USER_ID }),
                response.res
            );

            assert.equal(response.result.statusCode, 404);
            assert.equal(response.result.body.message, "Payment order not found.");
            assert.equal(findOneCalls, 1);
            assert.equal(lastFilter.razorpayOrderId, "order_does_not_exist");
        }

        // 5a. Empty order ID follows the controller's existing validation and
        //     does not reach the database.
        {
            reset();

            const response = makeRes();
            await getPaymentStatus(
                makeReq({ orderId: "" }, { userId: USER_ID }),
                response.res
            );

            assert.equal(response.result.statusCode, 400);
            assert.equal(response.result.body.message, "Order ID is required.");
            assert.equal(findOneCalls, 0);
        }

        // 5b. Missing order ID parameter follows the controller's existing
        //     validation and does not reach the database.
        {
            reset();

            const response = makeRes();
            await getPaymentStatus(makeReq({}, { userId: USER_ID }), response.res);

            assert.equal(response.result.statusCode, 400);
            assert.equal(response.result.body.message, "Order ID is required.");
            assert.equal(findOneCalls, 0);
        }

        // 6. CREATED order returns 200 with PENDING.
        {
            reset();
            const doc = seedPaymentOrder("CREATED");

            const response = makeRes();
            await getPaymentStatus(
                makeReq({ orderId: ORDER_ID }, { userId: USER_ID }),
                response.res
            );

            assert.equal(response.result.statusCode, 200);
            assert.equal(response.result.body.payment.status, "PENDING");
            assert.equal(response.result.body.payment.orderId, doc.razorpayOrderId);
            assert.equal(lastFilter.userId, USER_ID);
        }

        // 7. PAID order returns 200 with SUCCESS.
        {
            reset();
            seedPaymentOrder("PAID");

            const response = makeRes();
            await getPaymentStatus(
                makeReq({ orderId: ORDER_ID }, { userId: USER_ID }),
                response.res
            );

            assert.equal(response.result.statusCode, 200);
            assert.equal(response.result.body.payment.status, "SUCCESS");
        }

        // 8. FAILED order returns 200 with FAILED.
        {
            reset();
            seedPaymentOrder("FAILED");

            const response = makeRes();
            await getPaymentStatus(
                makeReq({ orderId: ORDER_ID }, { userId: USER_ID }),
                response.res
            );

            assert.equal(response.result.statusCode, 200);
            assert.equal(response.result.body.payment.status, "FAILED");
        }

        // 9. Response contains only the documented fields.
        {
            reset();
            const doc = seedPaymentOrder("CREATED");

            const response = makeRes();
            await getPaymentStatus(
                makeReq({ orderId: ORDER_ID }, { userId: USER_ID }),
                response.res
            );

            assert.deepEqual(Object.keys(response.result.body).sort(), [
                "message",
                "payment"
            ]);

            assert.deepEqual(Object.keys(response.result.body.payment).sort(), [
                "amount",
                "createdAt",
                "currency",
                "orderId",
                "status",
                "updatedAt"
            ]);

            assert.equal(response.result.body.payment.amount, doc.amount);
            assert.equal(response.result.body.payment.currency, doc.currency);
            assert.equal(response.result.body.payment.createdAt, doc.createdAt);
            assert.equal(response.result.body.payment.updatedAt, doc.updatedAt);
        }

        // 10. Database error returns a generic 500 without exposing internals.
        {
            reset();
            findOneImpl = async () => {
                throw new Error("database unavailable");
            };

            const originalConsoleError = console.error;
            console.error = () => undefined;

            try {
                const response = makeRes();
                await getPaymentStatus(
                    makeReq({ orderId: ORDER_ID }, { userId: USER_ID }),
                    response.res
                );

                assert.equal(response.result.statusCode, 500);
                assert.deepEqual(response.result.body, {
                    message: "Failed to fetch payment status."
                });
            } finally {
                console.error = originalConsoleError;
            }
        }

        console.log("payment-status tests: 11 passed");
    } finally {
        // No global state to restore beyond the per-test console.error guard.
    }
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
