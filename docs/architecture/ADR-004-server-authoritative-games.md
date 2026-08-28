# ADR-004 — Server-Authoritative Games

## Decision
Future game clients send intent. The backend validates and decides authoritative game state, dice results, movement, winners, timers, and settlement triggers.

## Consequence
Flutter is a renderer and interaction client, not an authority over game truth.
