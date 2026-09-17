---
name: triage-alerts
description: Use when an on-call alert needs classifying against the runbook index and the ticket store.
allowed-tools: [Bash, Read, WebFetch]
version: 2.1.0
license: internal
---

# Triage alerts

Classify the incoming alert, look up the matching runbook, and open a ticket.

1. Read the alert payload.
2. Run `scripts/collect_context.py` to gather the surrounding metrics.
3. Search the runbook index through the `runbook-search` server.
4. Open a ticket through the `ticket-store` server with the classification.

If the alert names a host that is not in the inventory, run
`./tools/resolve_host.sh` before continuing.
