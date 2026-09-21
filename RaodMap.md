from pathlib import Path

content = r"""# Payment / FinTech Backend Engineer Roadmap

## Target

**Goal:** Prepare for backend/FinTech/payment-engineering roles at companies such as Stripe, Juspay, Razorpay, and similar payment/financial technology companies.

**Estimated timeline:** 8–12 months for strong preparation.

### Expected pace

- [ ] 2–3 hours/day → approximately 10–12 months
- [ ] 4–5 hours/day → approximately 7–9 months
- [ ] 6+ hours/day → approximately 5–7 months

> You do not need to wait until the roadmap is completely finished before applying. Start applying to general backend, FinTech, internship, and junior roles around Month 4–6 while continuing the roadmap.

---

# Phase 1 — Backend Fundamentals
## Month 1–2

### TypeScript

- [ ] Type aliases and interfaces
- [ ] Generics
- [ ] Utility types
- [ ] Discriminated unions
- [ ] Strict TypeScript
- [ ] DTOs
- [ ] Type-safe API design
- [ ] Error types and error handling

### Node.js

- [ ] Event loop
- [ ] Async/await
- [ ] Promises
- [ ] Error handling
- [ ] Streams
- [ ] Buffers
- [ ] Concurrency basics
- [ ] Graceful shutdown
- [ ] Connection pooling
- [ ] Node.js performance basics

### Express / REST APIs

- [ ] REST API design
- [ ] Controllers
- [ ] Services
- [ ] Repositories
- [ ] Middleware
- [ ] Validation
- [ ] Centralized error handling
- [ ] Pagination
- [ ] Filtering and sorting
- [ ] API versioning
- [ ] Swagger / OpenAPI

### Authentication & Authorization

- [ ] JWT
- [ ] Sessions
- [ ] Password hashing
- [ ] Refresh tokens
- [ ] RBAC
- [ ] API keys
- [ ] MFA basics
- [ ] Secure cookies
- [ ] Authorization middleware

### PostgreSQL

- [ ] SQL fundamentals
- [ ] Table relationships
- [ ] Primary keys
- [ ] Foreign keys
- [ ] Constraints
- [ ] Indexes
- [ ] Composite indexes
- [ ] Joins
- [ ] Transactions
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

- [ ] User registration
- [ ] Wallet creation
- [ ] Wallet balance
- [ ] Add money
- [ ] Withdraw money
- [ ] Transfer money
- [ ] Transaction history
- [ ] Currency handling
- [ ] Store money as integer paise/cents
- [ ] Prevent negative balances

### Transactions

- [ ] Database transactions
- [ ] Atomic operations
- [ ] Concurrent transfer handling
- [ ] Row-level locking
- [ ] Deadlock handling
- [ ] Transaction states
- [ ] Failed transaction handling
- [ ] Retry strategy

### Double-entry Ledger

- [ ] Understand double-entry accounting
- [ ] Create ledger accounts
- [ ] Create debit entries
- [ ] Create credit entries
- [ ] Link ledger entries to transactions
- [ ] Track balance before/after
- [ ] Make ledger entries immutable
- [ ] Verify that debits and credits balance

Example:

```text
Wallet A ── Debit  ₹500
Wallet B ── Credit ₹500