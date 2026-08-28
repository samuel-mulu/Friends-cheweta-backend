# ADR-001 — Modular Monolith

## Decision
Friends Game Hub starts as one NestJS modular monolith.

## Why
It keeps deployment, transactions, debugging, and development simple while preserving clear module boundaries.

## Revisit when
A module has a demonstrated need for independent deployment or scaling. Do not split services because of hypothetical future load.
