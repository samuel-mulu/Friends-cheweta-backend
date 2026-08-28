# ADR-002 — PostgreSQL Is Durable Truth

## Decision
PostgreSQL owns durable users, financial balances, ledger records, payment records, match records, settlements, and audit history.

## Why
Financial and historical state must survive process, cache, and realtime failures.

## Consequence
Redis may later hold hot runtime state but must never become the only source of financial truth.
