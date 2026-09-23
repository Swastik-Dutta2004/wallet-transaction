from pathlib import Path

content = r"""# Payment / FinTech Backend Engineer Roadmap

## Target

**Goal:** Prepare for backend/FinTech/payment-engineering roles at companies such as Stripe, Juspay, Razorpay, and similar payment/financial technology companies.

**Estimated timeline:** 8–12 months for strong preparation.

### Expected pace

- [ ] 2–3 hours/day → approximately 10–12 months
- [ ] 4–5 hours/day → approximately 7–9 months
- [x] 6+ hours/day → approximately 5–7 months

> You do not need to wait until the roadmap is completely finished before applying. Start applying to general backend, FinTech, internship, and junior roles around Month 4–6 while continuing the roadmap.

---

# Phase 1 — Backend Fundamentals
## Month 1–2

### TypeScript

- [x] Type aliases and interfaces
- [ ] Generics
- [ ] Utility types
- [ ] Discriminated unions
- [x] Strict TypeScript
- [ ] DTOs
- [ ] Type-safe API design
- [x] Error types and error handling

### Node.js

- [x] Event loop
- [x] Async/await
- [x] Promises
- [x] Error handling
- [ ] Streams
- [ ] Buffers
- [ ] Concurrency basics
- [ ] Graceful shutdown
- [ ] Connection pooling
- [ ] Node.js performance basics

### Express / REST APIs

- [x] REST API design
- [x] Controllers
- [x] Services
- [x] Repositories
- [x] Middleware
- [ ] Validation
- [ ] Centralized error handling
- [ ] Pagination
- [ ] Filtering and sorting
- [ ] API versioning
- [ ] Swagger / OpenAPI

### Authentication & Authorization

- [x] JWT
- [ ] Sessions
- [x] Password hashing
- [x] Refresh tokens
- [ ] RBAC
- [x] API keys
- [ ] MFA basics
- [x] Secure cookies
- [x] Authorization middleware

### PostgreSQL

- [x] SQL fundamentals
- [x] Table relationships
- [x] Primary keys
- [x] Foreign keys
- [ ] Constraints
- [ ] Indexes
- [ ] Composite indexes
- [ ] Joins
- [x] Transactions
- [ ] ACID
- [ ] Isolation levels
- [ ] Row locking
- [ ] `SELECT FOR UPDATE`
- [ ] Deadlocks
- [ ] Connection pooling
- [ ] Query optimization
- [ ] Database migrations

### Project checkpoint

- [ ] Build a clean TypeScript + Node.js + PostgreSQL REST API
- [ ] Add authentication
- [ ] Add validation
- [ ] Add Swagger/OpenAPI
- [ ] Add unit tests
- [ ] Add integration tests

---

# Phase 2 — Financial Systems
## Month 3–4

## Upgrade the existing Wallet Project

### Wallet

- [x] User registration
- [x] Wallet creation
- [x] Wallet balance
- [x] Add money
- [ ] Withdraw money
- [x] Transfer money
- [x] Transaction history
- [ ] Currency handling
- [x] Store money as integer paise/cents
- [x] Prevent negative balances

### Transactions

- [x] Database transactions
- [ ] Atomic operations
- [ ] Concurrent transfer handling
- [ ] Row-level locking
- [ ] Deadlock handling
- [ ] Transaction states
- [ ] Failed transaction handling
- [ ] Retry strategy

### Double-entry Ledger

- [ ] Understand double-entry accounting
- [x] Create ledger accounts
- [x] Create debit entries
- [x] Create credit entries
- [x] Link ledger entries to transactions
- [x] Track balance before/after
- [ ] Make ledger entries immutable
- [x] Verify that debits and credits balance

Example:

```text
Wallet A ── Debit  ₹500
Wallet B ── Credit ₹500