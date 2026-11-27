import assert from "node:assert/strict";

// Patch the SDK before loading the controller, which constructs its own
// Razorpay client at module import time.
const Razorpay = require("razorpay");
const originalAddResources = Razorpay.prototype.addResources;

let createImpl: (params: any) => Promise<any> = async (params) => ({
    id: "order_created",
    amount: params.amount,
    currency: params.currency,
    receipt: params.receipt,
    status: "created"
});
let allItemsImpl: (params: any) => Promise<any[]> = async () => [];

const fakeOrders = {
    create: async (params: any) => await createImpl(params),
    all: async (params: any) => ({ items: await allItemsImpl(params) })
};

Razorpay.prototype.addResources = function () {
    originalAddResources.call(this);
    this.orders = fakeOrders;
};

process.env.RAZORPAY_KEY_ID = "test_key";
process.env.RAZORPAY_KEY_SECRET = "test_secret";
process.env.ORDER_CREATION_LEASE_MS = "1000";

const LEASE_MS = 1000;
const USER_ID = "507f1f77bcf86cd799439011";

const { createOrder } = require("../controllers/payment.controller");
const PaymentOrder = require("../models/payment-order.models").default;

type FakeDoc = {
    _id: string;
    userId: string;
    razorpayOrderId: string;
    amount: number;
    currency: string;
    idempotencyKey: string;
    status: string;
    creationDispatchedAt?: Date | null;
    creationClaimToken?: string | null;
    createdAt: Date;
    updatedAt: Date;
};

const store = new Map<string, FakeDoc>();
let createCalls = 0;
let beforeUpdateOne:
    | ((filter: any, update: any) => Promise<void>)
    | null = null;
let blockDispatchMarker = false;

function creatingMarker(key: string, token: string): string {
    return `creating_order_${key}:${token}`;
}

function callingMarker(key: string, token: string): string {
    return `calling_order_${key}:${token}`;
}

function matches(doc: FakeDoc, filter: any): boolean {
    for (const [field, expected] of Object.entries(filter)) {
        if (field === "_id") {
            if (String((doc as any)._id) !== String(expected)) {
                return false;
            }
            continue;
        }

        const actual = (doc as any)[field];

        if (expected === null || expected === undefined) {
            if (actual !== expected) {
                return false;
            }
            continue;
        }

        if (
            expected &&
            typeof expected === "object" &&
            !Array.isArray(expected) &&
            !(expected instanceof Date)
        ) {
            const condition = expected as Record<string, any>;

            if ("$in" in condition) {
                const allowed = condition.$in as unknown[];
                if (!allowed.some((value) => String(actual) === String(value))) {
                    return false;
                }
            }

            if ("$lte" in condition) {
                if (
                    !(actual instanceof Date) ||
                    actual.getTime() > new Date(condition.$lte).getTime()
                ) {
                    return false;
                }
            }

            if ("$ne" in condition) {
                const excluded = condition.$ne;
                const isEqual =
                    excluded === null
                        ? actual === null || actual === undefined
                        : String(actual) === String(excluded);
                if (isEqual) {
                    return false;
                }
            }

            const unsupported = Object.keys(condition).filter(
                (operator) =>
                    operator !== "$in" &&
                    operator !== "$lte" &&
                    operator !== "$ne"
            );
            if (unsupported.length > 0) {
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

function findOne(filter: any): FakeDoc | null {
    return [...store.values()].find((doc) => matches(doc, filter)) ?? null;
}

(PaymentOrder as any).findOne = async (filter: any) => findOne(filter);

(PaymentOrder as any).findById = async (id: any) =>
    store.get(String(id)) ?? null;

async function applyUpdateOne(filter: any, update: any) {
    const doc = findOne(filter);
    if (!doc) {
        return { matchedCount: 0 };
    }

    Object.assign(doc, update?.$set ?? {});
    doc.updatedAt = new Date();
    return { matchedCount: 1 };
}

(PaymentOrder as any).updateOne = async (filter: any, update: any) => {
    const nextMarker = String(update?.$set?.razorpayOrderId ?? "");

    if (blockDispatchMarker && nextMarker.startsWith("calling_order_")) {
        return { matchedCount: 0 };
    }

    if (beforeUpdateOne) {
        await beforeUpdateOne(filter, update);
    }

    return await applyUpdateOne(filter, update);
};

(PaymentOrder as any).findOneAndUpdate = async (
    filter: any,
    update: any
) => {
    const doc = findOne(filter);
    if (!doc) {
        return null;
    }

    Object.assign(doc, update?.$set ?? {});
    doc.updatedAt = new Date();
    return doc;
};

(PaymentOrder.prototype as any).save = async function () {
    const doc: FakeDoc = {
        _id: String(this._id),
        userId: String(this.userId),
        razorpayOrderId: this.razorpayOrderId,
        amount: this.amount,
        currency: this.currency,
        idempotencyKey: this.idempotencyKey,
        status: this.status,
        creationDispatchedAt: this.creationDispatchedAt ?? null,
        creationClaimToken: this.creationClaimToken ?? null,
        createdAt: new Date(),
        updatedAt: new Date()
    };

    store.set(doc._id, doc);
    this.updatedAt = doc.updatedAt;
    return this;
};

function reset(): void {
    store.clear();
    createCalls = 0;
    beforeUpdateOne = null;
    blockDispatchMarker = false;
    createImpl = async (params) => {
        createCalls += 1;
        return {
            id: "order_created",
            amount: params.amount,
            currency: params.currency,
            receipt: params.receipt,
            status: "created"
        };
    };
    allItemsImpl = async () => [];
}

function seedDoc(options: {
    key: string;
    marker: string;
    ageMs?: number;
    idempotencyKey?: string;
    legacy?: boolean;
    creationDispatchedAt?: Date | null;
    claimToken?: string | null;
}): FakeDoc {
    const now = Date.now();
    const doc: FakeDoc = {
        _id: `doc-${options.key}`,
        userId: USER_ID,
        razorpayOrderId: options.marker,
        amount: 100,
        currency: "INR",
        idempotencyKey: options.idempotencyKey ?? options.key,
        status: "CREATED",
        creationDispatchedAt: options.legacy
            ? undefined
            : options.creationDispatchedAt ?? null,
        creationClaimToken: options.legacy
            ? undefined
            : options.claimToken ?? null,
        createdAt: new Date(now - LEASE_MS),
        updatedAt: new Date(now - (options.ageMs ?? 0))
    };

    store.set(doc._id, doc);
    return doc;
}

function makeReq(key: string) {
    return {
        user: { userId: USER_ID },
        headers: { "idempotency-key": key },
        body: { amount: 1 }
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
    const originalConsoleError = console.error;
    console.error = () => undefined;

    try {
        // 1. Concurrent requests: only the claim winner calls Razorpay.
        {
            reset();
            let releaseCreate!: () => void;
            let signalCreateStarted!: () => void;
            const createStarted = new Promise<void>((resolve) => {
                signalCreateStarted = resolve;
            });
            const createGate = new Promise<void>((resolve) => {
                releaseCreate = resolve;
            });

            createImpl = async (params) => {
                createCalls += 1;
                signalCreateStarted();
                await createGate;
                return {
                    id: "order_created",
                    amount: params.amount,
                    currency: params.currency,
                    receipt: params.receipt,
                    status: "created"
                };
            };

            const first = makeRes();
            const firstRequest = createOrder(makeReq("concurrent"), first.res);
            await createStarted;

            const second = makeRes();
            await createOrder(makeReq("concurrent"), second.res);

            assert.equal(createCalls, 1);
            assert.equal(second.result.statusCode, 503);

            releaseCreate();
            await firstRequest;

            assert.equal(first.result.statusCode, 201);
            assert.equal(createCalls, 1);
            assert.equal(
                [...store.values()][0].razorpayOrderId,
                "order_created"
            );
        }

        // 2. Fresh creating claim is still considered in progress.
        {
            reset();
            const token = "fresh-token";
            const marker = creatingMarker("fresh-claim", token);
            const doc = seedDoc({
                key: "fresh-claim",
                marker,
                claimToken: token
            });

            const response = makeRes();
            await createOrder(makeReq("fresh-claim"), response.res);

            assert.equal(response.result.statusCode, 409);
            assert.equal(createCalls, 0);
            assert.equal(doc.razorpayOrderId, marker);
        }

        // 3. Abandoned creating claim with no Razorpay order is recoverable.
        {
            reset();
            const token = "abandoned-token";
            seedDoc({
                key: "abandoned",
                marker: creatingMarker("abandoned", token),
                claimToken: token,
                ageMs: LEASE_MS * 5
            });

            const response = makeRes();
            await createOrder(makeReq("abandoned"), response.res);

            assert.equal(response.result.statusCode, 200);
            assert.equal(createCalls, 1);
            assert.equal(
                [...store.values()][0].razorpayOrderId,
                "order_created"
            );
        }

        // 4. Two abandoned retries: only one may dispatch a new create.
        {
            reset();
            const token = "abandoned-race-token";
            seedDoc({
                key: "abandoned-race",
                marker: creatingMarker("abandoned-race", token),
                claimToken: token,
                ageMs: LEASE_MS * 5
            });

            const first = makeRes();
            const second = makeRes();
            await Promise.all([
                createOrder(makeReq("abandoned-race"), first.res),
                createOrder(makeReq("abandoned-race"), second.res)
            ]);

            assert.equal(createCalls, 1);
            const statuses = [
                first.result.statusCode,
                second.result.statusCode
            ];
            assert.equal(statuses.filter((status) => status === 200).length, 1);
            assert.ok(
                statuses.some((status) => status === 409 || status === 503)
            );
        }

        // 5. Creating claim that already has a Razorpay order is replayed.
        {
            reset();
            const token = "created-not-persisted-token";
            seedDoc({
                key: "created-not-persisted",
                marker: creatingMarker("created-not-persisted", token),
                claimToken: token,
                ageMs: LEASE_MS * 5
            });
            allItemsImpl = async (params) => [
                {
                    id: "order_recovered",
                    amount: 100,
                    currency: "INR",
                    receipt: params.receipt,
                    status: "created"
                }
            ];

            const response = makeRes();
            await createOrder(
                makeReq("created-not-persisted"),
                response.res
            );

            assert.equal(response.result.statusCode, 200);
            assert.equal(createCalls, 0);
            assert.equal(
                [...store.values()][0].razorpayOrderId,
                "order_recovered"
            );
        }

        // 6. Calling marker is never lease-released or blindly recreated.
        {
            reset();
            const token = "uncertain-token";
            const doc = seedDoc({
                key: "uncertain",
                marker: callingMarker("uncertain", token),
                claimToken: token,
                ageMs: LEASE_MS * 5,
                creationDispatchedAt: new Date(Date.now() - LEASE_MS * 5)
            });

            const response = makeRes();
            await createOrder(makeReq("uncertain"), response.res);

            assert.equal(response.result.statusCode, 503);
            assert.equal(response.result.body.requiresReconciliation, true);
            assert.equal(createCalls, 0);
            assert.equal(doc.razorpayOrderId, callingMarker("uncertain", token));
            assert.equal(doc.creationClaimToken, token);
        }

        // 7. Documented validation rejection with structured evidence releases
        // the exact claim.
        {
            reset();
            createImpl = async () => {
                createCalls += 1;
                throw {
                    statusCode: 400,
                    error: {
                        code: "BAD_REQUEST_ERROR",
                        description: "The amount must be at least INR 1.00",
                        reason: "input_validation_failed",
                        field: "amount"
                    }
                };
            };

            const response = makeRes();
            await createOrder(makeReq("definitive"), response.res);

            const doc = [...store.values()][0];
            assert.equal(response.result.statusCode, 400);
            assert.equal(createCalls, 1);
            assert.equal(doc.razorpayOrderId, "pending_order_definitive");
            assert.equal(doc.creationClaimToken, null);
            assert.equal(doc.creationDispatchedAt, null);
        }

        // 8. A generic 400 with no description is ambiguous, so the calling
        // marker is retained for reconciliation.
        {
            reset();
            createImpl = async () => {
                createCalls += 1;
                throw {
                    statusCode: 400,
                    error: {
                        code: "BAD_REQUEST_ERROR"
                    }
                };
            };

            const response = makeRes();
            await createOrder(makeReq("ambiguous-generic"), response.res);

            const doc = [...store.values()][0];
            assert.equal(response.result.statusCode, 503);
            assert.equal(response.result.body.requiresReconciliation, true);
            assert.equal(createCalls, 1);
            assert.ok(
                doc.razorpayOrderId.startsWith("calling_order_ambiguous-generic:")
            );
            assert.ok(doc.creationDispatchedAt instanceof Date);
        }

        // 9. Duplicate-receipt style 400 stays unresolved for reconciliation.
        {
            reset();
            createImpl = async () => {
                createCalls += 1;
                throw {
                    statusCode: 400,
                    error: {
                        code: "BAD_REQUEST_ERROR",
                        description:
                            "Duplicate request. This request has already been processed."
                    }
                };
            };

            const response = makeRes();
            await createOrder(makeReq("duplicate"), response.res);

            const doc = [...store.values()][0];
            assert.equal(response.result.statusCode, 503);
            assert.equal(response.result.body.requiresReconciliation, true);
            assert.equal(createCalls, 1);
            assert.ok(
                doc.razorpayOrderId.startsWith("calling_order_duplicate:")
            );
        }

        // 10. Legacy creating marker without a claim token is never released.
        {
            reset();
            const doc = seedDoc({
                key: "legacy",
                marker: "creating_order_legacy",
                ageMs: LEASE_MS * 5,
                legacy: true
            });

            const response = makeRes();
            await createOrder(makeReq("legacy"), response.res);

            assert.equal(response.result.statusCode, 503);
            assert.equal(response.result.body.requiresReconciliation, true);
            assert.equal(createCalls, 0);
            assert.equal(doc.razorpayOrderId, "creating_order_legacy");
        }

        // 11. A stale claim cannot dispatch after another request recovers and
        // reclaims the order with a different token.
        {
            reset();
            let signalDispatchAttempt!: () => void;
            let releaseDispatchAttempt!: () => void;
            const dispatchAttempt = new Promise<void>((resolve) => {
                signalDispatchAttempt = resolve;
            });
            const dispatchGate = new Promise<void>((resolve) => {
                releaseDispatchAttempt = resolve;
            });

            let staleMarker = "";
            let staleToken = "";

            beforeUpdateOne = async (filter, update) => {
                const currentMarker = String(filter.razorpayOrderId ?? "");
                const nextMarker = String(
                    update?.$set?.razorpayOrderId ?? ""
                );

                if (
                    currentMarker.startsWith("creating_order_stale-generation:") &&
                    nextMarker.startsWith("calling_order_stale-generation:")
                ) {
                    staleMarker = currentMarker;
                    staleToken = String(filter.creationClaimToken);
                    beforeUpdateOne = null;
                    signalDispatchAttempt();
                    await dispatchGate;
                }
            };

            const stale = makeRes();
            const staleRequest = createOrder(
                makeReq("stale-generation"),
                stale.res
            );

            await dispatchAttempt;

            const staleDoc = findOne({
                idempotencyKey: "stale-generation"
            })!;
            assert.ok(staleMarker);
            assert.ok(staleToken);
            assert.equal(staleDoc.razorpayOrderId, staleMarker);
            assert.equal(staleDoc.creationClaimToken, staleToken);
            assert.equal(staleDoc.creationDispatchedAt, null);

            // Simulate the lease expiring while the first request is paused
            // before its dispatch write.
            staleDoc.updatedAt = new Date(Date.now() - LEASE_MS * 5);

            const reclaim = makeRes();
            await createOrder(makeReq("stale-generation"), reclaim.res);

            assert.equal(reclaim.result.statusCode, 200);
            assert.equal(createCalls, 1);

            const reclaimedDoc = findOne({
                idempotencyKey: "stale-generation"
            })!;
            assert.equal(reclaimedDoc.razorpayOrderId, "order_created");
            assert.equal(reclaimedDoc.creationClaimToken, null);

            releaseDispatchAttempt();
            await staleRequest;

            assert.equal(createCalls, 1);
            assert.equal(stale.result.statusCode, 200);
            assert.equal(stale.result.body.order.id, "order_created");
        }

        // 12. Failure to write the dispatch marker prevents the external call.
        {
            reset();
            blockDispatchMarker = true;

            const response = makeRes();
            await createOrder(makeReq("dispatch-failure"), response.res);

            const doc = findOne({ idempotencyKey: "dispatch-failure" })!;
            assert.equal(createCalls, 0);
            assert.ok(
                doc.razorpayOrderId.startsWith("creating_order_dispatch-failure:")
            );
            assert.ok(doc.creationClaimToken);
            assert.equal(doc.creationDispatchedAt, null);
            assert.equal(response.result.statusCode, 409);
        }

        console.log("order-claim tests: 12 passed");
    } finally {
        console.error = originalConsoleError;
    }
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
