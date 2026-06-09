"""Billing agent (optional) — finalized private encounter → Stripe invoice.

Only runs when state['enable_billing'] is true and a private-pay/clinic context applies (a charge in
a public-hospital / SUS flow reads as forced). Real: Stripe Invoices / PaymentIntents; surface the
receipt URL in the UI. Scores under: Tool Use + Stripe prize.
"""
from __future__ import annotations

import asyncio

from app.events import publish

AGENT = "billing"


async def run_billing(state: dict) -> dict:
    session_id = state["session_id"]
    await publish(session_id, {"agent": AGENT, "status": "running"})
    await asyncio.sleep(0.5)

    # TODO(real): stripe.Invoice.create(...) / stripe.PaymentIntent.create(...); return receipt URL.
    invoice = {"invoice_id": f"in_demo_{session_id[:6]}", "amount_cents": 15000, "status": "draft"}

    await publish(session_id, {"agent": AGENT, "status": "done", **invoice})
    return {"invoice": invoice}
