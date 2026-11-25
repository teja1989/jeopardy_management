#!/usr/bin/env python3
"""
Jeopardy Management & Predictive SLA Tracker — Local Multi-Domain Kafka Simulator

Publishes realistic, deeply nested, DELIBERATELY UNPARTITIONED (key=None) JSON
payloads across all 8 source Kafka topics to faithfully simulate AWS MSK arrival
skew, 1-to-N multi-item Order fan-out, 3-level Flowable (processInstanceId,
parentProcessInstanceId) hierarchies, Fallout Management BPMN overlays, ~95%
Flowable BPMN micro-event noise, out-of-order child-before-parent arrival, and
poison-pill malformed JSON payloads.

Usage:
  python3 tools/event-simulator/simulate.py --scenario all --include-poison-pill --out-of-order --dry-run
  python3 tools/event-simulator/simulate.py --bootstrap-servers localhost:29092 --scenario happy --noise-per-order 120
"""

from __future__ import annotations

import argparse
import collections
import json
import random
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
from catalog_50_items import CATALOG_50_ITEMS, ItemTypeSpec  # noqa: E402

SOURCE_TOPICS: Tuple[str, ...] = (
    "flowable.activity.events",
    "flowable.fallout.events",
    "domain.order.events",
    "domain.fraud.events",
    "domain.payment.events",
    "domain.fulfillment.events",
    "domain.provisioning.events",
    "domain.billing.events",
)

NOISE_EVENT_TYPES: Tuple[Tuple[str, str, str], ...] = (
    ("VARIABLE_UPDATED", "scriptTask", "updateProcessCtxVars"),
    ("SEQUENCEFLOW_TAKEN", "sequenceFlow", "flow_eval_route"),
    ("ACTIVITY_STARTED", "exclusiveGateway", "gw_check_inventory_route"),
    ("ACTIVITY_COMPLETED", "exclusiveGateway", "gw_check_inventory_route"),
    ("ENTITY_UPDATED", "parallelGateway", "gw_parallel_sync"),
    ("VARIABLE_CREATED", "scriptTask", "initTempCorrelationVar"),
    ("ENGINE_HEARTBEAT", "sequenceFlow", "engine_tick"),
)


@dataclass
class SimulatedRecord:
    topic: str
    payload: Optional[Dict[str, Any]] = None
    raw_bytes: Optional[bytes] = None
    is_noise: bool = False
    is_poison_pill: bool = False
    is_ooo_injected: bool = False
    tag: str = ""

    def serialize(self) -> bytes:
        if self.raw_bytes is not None:
            return self.raw_bytes
        return json.dumps(self.payload, separators=(",", ":")).encode("utf-8")


class EventClock:
    """Monotonic UTC event-time generator for realistic scenario timestamps."""

    def __init__(self, start_utc: Optional[datetime] = None) -> None:
        self._now = start_utc or datetime.now(timezone.utc)

    def advance(self, seconds: int = 1, minutes: int = 0, hours: int = 0, days: int = 0) -> str:
        self._now += timedelta(seconds=seconds, minutes=minutes, hours=hours, days=days)
        return self._now.isoformat().replace("+00:00", "Z")


def new_event_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def generate_flowable_noise(
    rng: random.Random,
    clock: EventClock,
    process_instances: List[Tuple[str, Optional[str], str]],
    count: int,
    scenario_tag: str,
) -> List[SimulatedRecord]:
    """Generate Flowable BPMN micro-event noise (~95% dropped in Flink Stage 1)."""
    records: List[SimulatedRecord] = []
    for i in range(count):
        proc_id, parent_id, proc_def_key = rng.choice(process_instances)
        evt_type, act_type, act_id = rng.choice(NOISE_EVENT_TYPES)
        payload = {
            "eventId": new_event_id("flw-noise"),
            "eventTime": clock.advance(seconds=1),
            "eventType": evt_type,
            "processInstanceId": proc_id,
            "parentProcessInstanceId": parent_id,
            "processDefinitionKey": proc_def_key,
            "activityId": f"{act_id}_{i % 7}",
            "activityName": f"Internal Engine Step {i % 7}",
            "activityType": act_type,
            "variables": {
                "loopCounter": i,
                "transientFlag": bool(i % 2),
                "executionNode": f"flowable-node-{(i % 4) + 1}",
            },
        }
        records.append(
            SimulatedRecord(
                topic="flowable.activity.events",
                payload=payload,
                is_noise=True,
                tag=f"{scenario_tag}:noise",
            )
        )
    return records


def build_happy_iphone_upgrade_scenario(
    rng: random.Random,
    clock: EventClock,
    noise_per_order: int,
    out_of_order: bool,
    order_id: str = "ORD-88412",
    account_id: str = "ACC-88412",
    tradein_id: str = "TRD-55091",
    promo_id: str = "INS-77301",
    proc_prefix: str = "P",
) -> List[SimulatedRecord]:
    """
    Scenario 1: iPhone 18 Pro Ship-to-Home Upgrade (ORD-88412)
      + Bundled 60-Day Google 10 Pro Trade-In (TRD-55091)
      + Auto Free Device Insurance (INS-77301)
      + 3-level nested Flowable BPMN (P-100 -> P-101 -> P-102 where P-102 has NO orderId!)
      + tradeInMainBpmn carrying BOTH tradeInOrderId AND orderId
    """
    p_root = f"{proc_prefix}-100"
    p_item = f"{proc_prefix}-101"
    p_deep_leaf = f"{proc_prefix}-102"
    p_tradein = f"{proc_prefix}-TRD-200"
    p_promo = f"{proc_prefix}-INS-300"

    records: List[SimulatedRecord] = []

    # 1. Nested 1-to-N Order Domain submission (with PII fields to exercise redactPaths)
    records.append(
        SimulatedRecord(
            topic="domain.order.events",
            tag="happy:order_submitted",
            payload={
                "eventId": new_event_id("ord"),
                "eventTime": clock.advance(seconds=2),
                "eventType": "ORDER_SUBMITTED",
                "sourceSystem": "OMS-CORE",
                "order": {
                    "orderId": order_id,
                    "orderType": "SALES_UPGRADE",
                    "status": "SUBMITTED",
                    "channel": "WEB_DIRECT",
                    "region": "US-WEST",
                    "storeId": "WEB-001",
                    "lineItemCount": 1,
                    "customer": {
                        "accountId": account_id,
                        "accountType": "VIP",
                        "priorityTier": "PLATINUM",
                        "ssn": "123-45-6789",
                        "email": "alex.rivera@example.com",
                        "phoneNumber": "+1-415-555-0199",
                        "dateOfBirth": "1988-06-14",
                    },
                    "payment": {
                        "cardNumber": "4111-1111-1111-4242",
                        "cvv": "842",
                        "billingZip": "94107",
                    },
                    "shippingAddress": {
                        "streetLine1": "742 Evergreen Terrace",
                        "city": "San Francisco",
                        "state": "CA",
                    },
                    "lineItems": [
                        {
                            "lineItemId": "ITM-1",
                            "itemType": "HANDSET_SHIP_TO_HOME",
                            "sku": "IPHONE-18-PRO-512-TITANIUM",
                            "deviceModel": "iPhone 18 Pro",
                            "fulfillmentMethod": "SHIP_TO_HOME",
                            "status": "SUBMITTED",
                            "tradeIn": {
                                "tradeInOrderId": tradein_id,
                                "parentLineItemId": "ITM-1",
                                "deviceModel": "Google Pixel 10 Pro",
                                "quotedCreditUsd": "650.00",
                                "returnWindowDays": "30",
                                "returnKitCarrier": "UPS",
                                "status": "QUOTE_LOCKED",
                            },
                            "autoPromos": [
                                {
                                    "promoOrderId": promo_id,
                                    "parentLineItemId": "ITM-1",
                                    "promoType": "FREE_DEVICE_INSURANCE",
                                    "partnerName": "ASSURANT",
                                    "promoCode": "FREE-PROTECT-12M",
                                    "benefitTermMonths": "12",
                                    "status": "TRIGGERED",
                                }
                            ],
                        }
                    ],
                },
            },
        )
    )

    # 2. Flowable 3-level hierarchy: P-100 -> P-101 -> P-102 (deep leaf has NO orderId!)
    evt_p100_start = SimulatedRecord(
        topic="flowable.activity.events",
        tag="happy:flowable_p100_start",
        payload={
            "eventId": new_event_id("flw"),
            "eventTime": clock.advance(seconds=1),
            "eventType": "PROCESS_STARTED",
            "processInstanceId": p_root,
            "parentProcessInstanceId": None,
            "processDefinitionKey": "salesOrderBpmn",
            "activityId": "start_sales_order",
            "activityName": "Start Sales Order BPMN",
            "activityType": "serviceTask",
            "variables": {
                "orderId": order_id,
                "orderType": "SALES_UPGRADE",
                "accountId": account_id,
                "accountType": "VIP",
                "customerSsn": "123-45-6789",
            },
        },
    )
    evt_p101_start = SimulatedRecord(
        topic="flowable.activity.events",
        tag="happy:flowable_p101_start",
        payload={
            "eventId": new_event_id("flw"),
            "eventTime": clock.advance(seconds=1),
            "eventType": "PROCESS_STARTED",
            "processInstanceId": p_item,
            "parentProcessInstanceId": p_root,
            "processDefinitionKey": "itemShipSubBpmn",
            "activityId": "task_warehouse_pick",
            "activityName": "Start Item Ship Sub-BPMN",
            "activityType": "callActivity",
            "variables": {
                "orderId": order_id,
                "orderItemId": "ITM-1",
                "orderType": "SALES_UPGRADE",
                "itemType": "HANDSET_SHIP_TO_HOME",
                "accountId": account_id,
                "accountType": "VIP",
                "warehouseId": "WH-DFW-02",
            },
        },
    )
    # CRITICAL: P-102 carries ONLY (processInstanceId, parentProcessInstanceId) — NO orderId!
    evt_p102_deep = SimulatedRecord(
        topic="flowable.activity.events",
        tag="happy:flowable_p102_deep_no_orderid",
        is_ooo_injected=out_of_order,
        payload={
            "eventId": new_event_id("flw"),
            "eventTime": clock.advance(seconds=2),
            "eventType": "ACTIVITY_COMPLETED",
            "processInstanceId": p_deep_leaf,
            "parentProcessInstanceId": p_item,
            "processDefinitionKey": "warehouseLabelSubBpmn",
            "activityId": "task_print_carrier_label",
            "activityName": "Generate UPS Airbill Label",
            "activityType": "serviceTask",
            "variables": {
                "carrierCode": "UPS_NEXT_DAY",
                "labelBatchId": "LBL-90821",
            },
        },
    )

    if out_of_order:
        # Deliberately emit deep child P-102 BEFORE P-101 and P-100 to test Stage 2 15s OOO buffer!
        records.extend([evt_p102_deep, evt_p101_start, evt_p100_start])
    else:
        records.extend([evt_p100_start, evt_p101_start, evt_p102_deep])

    # 3. tradeInMainBpmn carrying BOTH tradeInOrderId AND orderId (adapter must key by tradeInOrderId!)
    records.append(
        SimulatedRecord(
            topic="flowable.activity.events",
            tag="happy:flowable_tradein_main",
            payload={
                "eventId": new_event_id("flw"),
                "eventTime": clock.advance(seconds=2),
                "eventType": "PROCESS_STARTED",
                "processInstanceId": p_tradein,
                "parentProcessInstanceId": None,
                "processDefinitionKey": "tradeInMainBpmn",
                "activityId": "task_ship_return_kit",
                "activityName": "Initiate 60-Day Trade-In Process",
                "activityType": "serviceTask",
                "variables": {
                    "tradeInOrderId": tradein_id,
                    "orderId": order_id,
                    "accountId": account_id,
                    "accountType": "VIP",
                    "tradeInDeviceModel": "Google Pixel 10 Pro",
                },
            },
        )
    )

    # 4. freeInsurancePromoBpmn (internally triggered promo)
    records.append(
        SimulatedRecord(
            topic="flowable.activity.events",
            tag="happy:flowable_free_insurance",
            payload={
                "eventId": new_event_id("flw"),
                "eventTime": clock.advance(seconds=1),
                "eventType": "PROCESS_STARTED",
                "processInstanceId": p_promo,
                "parentProcessInstanceId": p_root,
                "processDefinitionKey": "freeInsurancePromoBpmn",
                "activityId": "task_partner_insurance_enroll",
                "activityName": "Enroll Free Device Insurance Promo",
                "activityType": "serviceTask",
                "variables": {
                    "promoOrderId": promo_id,
                    "parentOrderId": order_id,
                    "accountId": account_id,
                    "accountType": "VIP",
                    "partnerName": "ASSURANT",
                },
            },
        )
    )

    # 5. Fraud Domain events
    for evt_type, score_band in [("FRAUD_CHECK_STARTED", "PENDING"), ("FRAUD_CHECK_APPROVED", "LOW_RISK")]:
        records.append(
            SimulatedRecord(
                topic="domain.fraud.events",
                tag=f"happy:{evt_type.lower()}",
                payload={
                    "eventId": new_event_id("frd"),
                    "eventTime": clock.advance(seconds=15),
                    "eventType": evt_type,
                    "fraud": {
                        "orderId": order_id,
                        "orderType": "SALES_UPGRADE",
                        "accountId": account_id,
                        "accountType": "VIP",
                        "provider": "LEXISNEXIS_THREATMETRIX",
                        "riskBand": score_band,
                        "applicantSsn": "123-45-6789",
                        "deviceFingerprintIp": "203.0.113.42",
                    },
                },
            )
        )

    # 6. Payment Domain events
    for evt_type in ("PAYMENT_AUTH_STARTED", "PAYMENT_AUTH_CAPTURED"):
        records.append(
            SimulatedRecord(
                topic="domain.payment.events",
                tag=f"happy:{evt_type.lower()}",
                payload={
                    "eventId": new_event_id("pay"),
                    "eventTime": clock.advance(seconds=12),
                    "eventType": evt_type,
                    "payment": {
                        "orderId": order_id,
                        "orderType": "SALES_UPGRADE",
                        "accountId": account_id,
                        "accountType": "VIP",
                        "gateway": "CYBERSOURCE",
                        "methodType": "CREDIT_CARD",
                        "amountUsd": 148.92,
                        "currency": "USD",
                        "cardNumber": "4111-1111-1111-4242",
                        "cvv": "842",
                        "cardholderEmail": "alex.rivera@example.com",
                    },
                },
            )
        )

    # 7. Fulfillment Domain events (iPhone ship-to-home + Trade-In return kit)
    for evt_type, adv_hours in [
        ("WAREHOUSE_PICK_STARTED", 1),
        ("SHIPMENT_LABEL_CREATED", 2),
        ("CARRIER_IN_TRANSIT", 18),
        ("SHIPMENT_DELIVERED", 24),
    ]:
        records.append(
            SimulatedRecord(
                topic="domain.fulfillment.events",
                tag=f"happy:{evt_type.lower()}",
                payload={
                    "eventId": new_event_id("ful"),
                    "eventTime": clock.advance(hours=adv_hours),
                    "eventType": evt_type,
                    "fulfillment": {
                        "orderId": order_id,
                        "lineItemId": "ITM-1",
                        "orderType": "SALES_UPGRADE",
                        "accountId": account_id,
                        "accountType": "VIP",
                        "carrier": "UPS",
                        "warehouseId": "WH-DFW-02",
                        "trackingNumber": "1Z999AA10123456784",
                        "recipientPhone": "+1-415-555-0199",
                        "deliveryAddress": {"streetLine1": "742 Evergreen Terrace"},
                    },
                },
            )
        )

    # Trade-in return kit shipped (independent entityKey TRD-55091)
    records.append(
        SimulatedRecord(
            topic="domain.fulfillment.events",
            tag="happy:tradein_kit_shipped",
            payload={
                "eventId": new_event_id("ful"),
                "eventTime": clock.advance(hours=4),
                "eventType": "TRADEIN_KIT_SHIPPED",
                "fulfillment": {
                    "tradeInOrderId": tradein_id,
                    "orderId": order_id,
                    "orderType": "DEVICE_TRADE_IN",
                    "accountId": account_id,
                    "accountType": "VIP",
                    "carrier": "UPS",
                    "warehouseId": "WH-IND-04",
                    "trackingNumber": "1Z999BB20987654321",
                },
            },
        )
    )

    # 8. Provisioning Domain events (iPhone eSIM activation + Free Insurance partner enroll)
    for evt_type in ("ESIM_DOWNLOAD_STARTED", "ESIM_ACTIVATED"):
        records.append(
            SimulatedRecord(
                topic="domain.provisioning.events",
                tag=f"happy:{evt_type.lower()}",
                payload={
                    "eventId": new_event_id("prv"),
                    "eventTime": clock.advance(minutes=2),
                    "eventType": evt_type,
                    "provisioning": {
                        "orderId": order_id,
                        "lineItemId": "ITM-1",
                        "orderType": "SALES_UPGRADE",
                        "accountId": account_id,
                        "accountType": "VIP",
                        "subscriberMdn": "+1-415-555-0199",
                        "imsi": "310260987654321",
                        "esim": {"smDpVendor": "THALES", "eidLast6": "994821"},
                    },
                },
            )
        )

    for evt_type in ("PARTNER_PROMO_SUBMITTED", "PARTNER_PROMO_ENROLLED"):
        records.append(
            SimulatedRecord(
                topic="domain.provisioning.events",
                tag=f"happy:{evt_type.lower()}",
                payload={
                    "eventId": new_event_id("prv"),
                    "eventTime": clock.advance(minutes=1),
                    "eventType": evt_type,
                    "provisioning": {
                        "promoOrderId": promo_id,
                        "orderId": order_id,
                        "orderType": "INTERNAL_PROMO_PROVISIONING",
                        "accountId": account_id,
                        "accountType": "VIP",
                        "partner": {"partnerName": "ASSURANT", "policyNumber": "ASR-2026-88412"},
                    },
                },
            )
        )

    # 9. Billing Domain events (Sales Upgrade + Free Insurance promo SKU)
    records.append(
        SimulatedRecord(
            topic="domain.billing.events",
            tag="happy:billing_sync_completed",
            payload={
                "eventId": new_event_id("bil"),
                "eventTime": clock.advance(minutes=2),
                "eventType": "BILLING_SYNC_COMPLETED",
                "billing": {
                    "orderId": order_id,
                    "lineItemId": "ITM-1",
                    "orderType": "SALES_UPGRADE",
                    "accountId": account_id,
                    "accountType": "VIP",
                    "system": "AMDOCS_ENSEMBLE",
                    "cycleCode": "CYCLE-15",
                    "autopayToken": "tok_live_secret_9812",
                },
            },
        )
    )
    records.append(
        SimulatedRecord(
            topic="domain.billing.events",
            tag="happy:promo_sku_billed",
            payload={
                "eventId": new_event_id("bil"),
                "eventTime": clock.advance(seconds=30),
                "eventType": "PROMO_SKU_BILLED",
                "billing": {
                    "promoOrderId": promo_id,
                    "orderId": order_id,
                    "orderType": "INTERNAL_PROMO_PROVISIONING",
                    "accountId": account_id,
                    "accountType": "VIP",
                    "system": "AMDOCS_ENSEMBLE",
                    "cycleCode": "CYCLE-15",
                    "creditAmountUsd": "0.00",
                },
            },
        )
    )

    # 10. Order Completed (Sales Upgrade & Promo closed; Trade-In remains open for 60d!)
    records.append(
        SimulatedRecord(
            topic="domain.order.events",
            tag="happy:order_completed",
            payload={
                "eventId": new_event_id("ord"),
                "eventTime": clock.advance(seconds=20),
                "eventType": "ORDER_COMPLETED",
                "sourceSystem": "OMS-CORE",
                "order": {
                    "orderId": order_id,
                    "orderType": "SALES_UPGRADE",
                    "status": "COMPLETED",
                    "channel": "WEB_DIRECT",
                    "region": "US-WEST",
                    "customer": {"accountId": account_id, "accountType": "VIP"},
                    "lineItems": [{"lineItemId": "ITM-1", "itemType": "HANDSET_SHIP_TO_HOME", "status": "COMPLETED"}],
                },
            },
        )
    )

    # 11. Inject Flowable BPMN micro-event noise (~95% dropped in Flink Stage 1)
    records.extend(
        generate_flowable_noise(
            rng=rng,
            clock=clock,
            process_instances=[
                (p_root, None, "salesOrderBpmn"),
                (p_item, p_root, "itemShipSubBpmn"),
                (p_deep_leaf, p_item, "warehouseLabelSubBpmn"),
                (p_tradein, None, "tradeInMainBpmn"),
                (p_promo, p_root, "freeInsurancePromoBpmn"),
            ],
            count=noise_per_order,
            scenario_tag="happy",
        )
    )
    return records


def build_payment_change_scenario(
    rng: random.Random,
    clock: EventClock,
    noise_per_order: int,
    out_of_order: bool,
) -> List[SimulatedRecord]:
    """
    Scenario 2: VIP Change Order (ACC-44219, ORD-77201 + CHG-10294)
      Payment decline -> Fallout #F-9801 -> Short-Lived SUPP_PAYMENT_UPDATE
      pausing parent TMPL_PAYMENT_AUTH SLA clock -> Recovery!
    """
    order_id = "ORD-77201"
    change_id = "CHG-10294"
    account_id = "ACC-44219"
    p_order = "P-200"
    p_fallout = "P-200-F-9801"
    p_chg = "P-205"

    records: List[SimulatedRecord] = [
        SimulatedRecord(
            topic="domain.order.events",
            tag="payment_change:order_submitted",
            payload={
                "eventId": new_event_id("ord"),
                "eventTime": clock.advance(seconds=2),
                "eventType": "ORDER_SUBMITTED",
                "sourceSystem": "OMS-CORE",
                "order": {
                    "orderId": order_id,
                    "orderType": "SALES_UPGRADE",
                    "status": "SUBMITTED",
                    "channel": "CARE_ASSISTED",
                    "region": "US-EAST",
                    "lineItemCount": 1,
                    "customer": {
                        "accountId": account_id,
                        "accountType": "VIP",
                        "priorityTier": "DIAMOND",
                        "email": "jordan.patel@example.com",
                    },
                    "lineItems": [
                        {
                            "lineItemId": "ITM-1",
                            "itemType": "HANDSET_SHIP_TO_HOME",
                            "sku": "IPHONE-18-PRO-MAX-1TB",
                            "deviceModel": "iPhone 18 Pro Max",
                            "fulfillmentMethod": "SHIP_TO_HOME",
                            "status": "SUBMITTED",
                        }
                    ],
                },
            },
        ),
        SimulatedRecord(
            topic="flowable.activity.events",
            tag="payment_change:flowable_root",
            payload={
                "eventId": new_event_id("flw"),
                "eventTime": clock.advance(seconds=1),
                "eventType": "PROCESS_STARTED",
                "processInstanceId": p_order,
                "parentProcessInstanceId": None,
                "processDefinitionKey": "salesOrderBpmn",
                "activityId": "task_payment_auth",
                "activityName": "Authorize Order Payment",
                "activityType": "serviceTask",
                "variables": {
                    "orderId": order_id,
                    "orderType": "SALES_UPGRADE",
                    "accountId": account_id,
                    "accountType": "VIP",
                },
            },
        ),
        SimulatedRecord(
            topic="domain.fraud.events",
            tag="payment_change:fraud_approved",
            payload={
                "eventId": new_event_id("frd"),
                "eventTime": clock.advance(seconds=8),
                "eventType": "FRAUD_CHECK_APPROVED",
                "fraud": {
                    "orderId": order_id,
                    "orderType": "SALES_UPGRADE",
                    "accountId": account_id,
                    "accountType": "VIP",
                    "provider": "LEXISNEXIS_THREATMETRIX",
                    "riskBand": "LOW_RISK",
                },
            },
        ),
        SimulatedRecord(
            topic="domain.payment.events",
            tag="payment_change:payment_declined",
            payload={
                "eventId": new_event_id("pay"),
                "eventTime": clock.advance(seconds=10),
                "eventType": "PAYMENT_AUTH_DECLINED",
                "payment": {
                    "orderId": order_id,
                    "orderType": "SALES_UPGRADE",
                    "accountId": account_id,
                    "accountType": "VIP",
                    "gateway": "CYBERSOURCE",
                    "methodType": "CREDIT_CARD",
                    "declineCode": "E_PAYMENT_AVS_MISMATCH",
                    "cardNumber": "4000-0000-0000-0002",
                    "cvv": "999",
                },
            },
        ),
    ]

    # Fallout #F-9801 opens and enters Payment Care Queue
    fallout_opened = SimulatedRecord(
        topic="flowable.fallout.events",
        tag="payment_change:fallout_f9801_opened",
        is_ooo_injected=out_of_order,
        payload={
            "eventId": new_event_id("flt"),
            "eventTime": clock.advance(seconds=3),
            "eventType": "FALLOUT_OPENED",
            "processInstanceId": p_fallout,
            "parentProcessInstanceId": p_order,
            "processDefinitionKey": "falloutManagementBpmn",
            "variables": {
                "falloutId": "F-9801",
                "failedOrderId": order_id,
                "failedActivityId": "task_payment_auth",
                "failedTemplateId": "TMPL_PAYMENT_AUTH",
                "errorCode": "E_PAYMENT_AVS_MISMATCH",
                "errorMessage": "Issuer declined card due to billing ZIP AVS mismatch",
                "severity": "HIGH",
                "assignedQueue": "VIP_PAYMENT_RECOVERY_QUEUE",
                "retryCount": 1,
                "accountId": account_id,
                "accountType": "VIP",
                "customerEmail": "jordan.patel@example.com",
            },
        },
    )
    if out_of_order:
        # Inject Fallout event ahead of salesOrderBpmn PROCESS_STARTED to test Stage 2 buffer
        records.insert(1, fallout_opened)
    else:
        records.append(fallout_opened)

    records.extend(
        [
            SimulatedRecord(
                topic="flowable.fallout.events",
                tag="payment_change:fallout_f9801_in_queue",
                payload={
                    "eventId": new_event_id("flt"),
                    "eventTime": clock.advance(seconds=15),
                    "eventType": "FALLOUT_IN_QUEUE",
                    "processInstanceId": p_fallout,
                    "parentProcessInstanceId": p_order,
                    "processDefinitionKey": "falloutManagementBpmn",
                    "variables": {
                        "falloutId": "F-9801",
                        "failedOrderId": order_id,
                        "failedActivityId": "task_payment_auth",
                        "failedTemplateId": "TMPL_PAYMENT_AUTH",
                        "errorCode": "E_PAYMENT_AVS_MISMATCH",
                        "assignedQueue": "VIP_PAYMENT_RECOVERY_QUEUE",
                        "assignedAgent": "agent.mchen",
                        "retryCount": 1,
                        "accountId": account_id,
                        "accountType": "VIP",
                    },
                },
            ),
            # Short-lived Supplemental Payment Update Change Order CHG-10294
            SimulatedRecord(
                topic="domain.order.events",
                tag="payment_change:chg_10294_created",
                payload={
                    "eventId": new_event_id("ord"),
                    "eventTime": clock.advance(minutes=2),
                    "eventType": "CHANGE_ORDER_CREATED",
                    "sourceSystem": "OMS-CARE",
                    "order": {
                        "orderId": change_id,
                        "parentOrderId": order_id,
                        "orderType": "SUPP_PAYMENT_UPDATE",
                        "status": "IN_PROGRESS",
                        "channel": "CARE_ASSISTED",
                        "region": "US-EAST",
                        "customer": {"accountId": account_id, "accountType": "VIP"},
                        "lineItems": [],
                    },
                },
            ),
            SimulatedRecord(
                topic="flowable.activity.events",
                tag="payment_change:flowable_chg_10294",
                payload={
                    "eventId": new_event_id("flw"),
                    "eventTime": clock.advance(seconds=2),
                    "eventType": "PROCESS_STARTED",
                    "processInstanceId": p_chg,
                    "parentProcessInstanceId": p_order,
                    "processDefinitionKey": "changeOrderBpmn",
                    "activityId": "task_payment_auth",
                    "activityName": "Capture Replacement Payment Method",
                    "activityType": "serviceTask",
                    "variables": {
                        "changeOrderId": change_id,
                        "parentOrderId": order_id,
                        "orderType": "SUPP_PAYMENT_UPDATE",
                        "changeReason": "AVS_CARD_REPLACEMENT",
                        "accountId": account_id,
                        "accountType": "VIP",
                    },
                },
            ),
            SimulatedRecord(
                topic="domain.payment.events",
                tag="payment_change:chg_reauth_captured",
                payload={
                    "eventId": new_event_id("pay"),
                    "eventTime": clock.advance(seconds=35),
                    "eventType": "PAYMENT_REAUTH_CAPTURED",
                    "payment": {
                        "changeOrderId": change_id,
                        "orderId": order_id,
                        "orderType": "SUPP_PAYMENT_UPDATE",
                        "accountId": account_id,
                        "accountType": "VIP",
                        "gateway": "CYBERSOURCE",
                        "methodType": "APPLE_PAY",
                        "amountUsd": 182.40,
                        "currency": "USD",
                    },
                },
            ),
            SimulatedRecord(
                topic="domain.order.events",
                tag="payment_change:chg_10294_completed",
                payload={
                    "eventId": new_event_id("ord"),
                    "eventTime": clock.advance(seconds=10),
                    "eventType": "CHANGE_ORDER_COMPLETED",
                    "sourceSystem": "OMS-CARE",
                    "order": {
                        "orderId": change_id,
                        "parentOrderId": order_id,
                        "orderType": "SUPP_PAYMENT_UPDATE",
                        "status": "COMPLETED",
                        "channel": "CARE_ASSISTED",
                        "region": "US-EAST",
                        "customer": {"accountId": account_id, "accountType": "VIP"},
                        "lineItems": [],
                    },
                },
            ),
            SimulatedRecord(
                topic="flowable.fallout.events",
                tag="payment_change:fallout_f9801_retrying",
                payload={
                    "eventId": new_event_id("flt"),
                    "eventTime": clock.advance(seconds=5),
                    "eventType": "FALLOUT_RETRY_TRIGGERED",
                    "processInstanceId": p_fallout,
                    "parentProcessInstanceId": p_order,
                    "processDefinitionKey": "falloutManagementBpmn",
                    "variables": {
                        "falloutId": "F-9801",
                        "failedOrderId": order_id,
                        "failedActivityId": "task_payment_auth",
                        "failedTemplateId": "TMPL_PAYMENT_AUTH",
                        "errorCode": "E_PAYMENT_AVS_MISMATCH",
                        "assignedQueue": "VIP_PAYMENT_RECOVERY_QUEUE",
                        "assignedAgent": "agent.mchen",
                        "retryCount": 2,
                        "linkedChangeOrderId": change_id,
                        "accountId": account_id,
                        "accountType": "VIP",
                    },
                },
            ),
            SimulatedRecord(
                topic="domain.payment.events",
                tag="payment_change:parent_payment_captured",
                payload={
                    "eventId": new_event_id("pay"),
                    "eventTime": clock.advance(seconds=8),
                    "eventType": "PAYMENT_AUTH_CAPTURED",
                    "payment": {
                        "orderId": order_id,
                        "orderType": "SALES_UPGRADE",
                        "accountId": account_id,
                        "accountType": "VIP",
                        "gateway": "CYBERSOURCE",
                        "methodType": "APPLE_PAY",
                        "amountUsd": 182.40,
                        "currency": "USD",
                    },
                },
            ),
            SimulatedRecord(
                topic="flowable.fallout.events",
                tag="payment_change:fallout_f9801_resolved",
                payload={
                    "eventId": new_event_id("flt"),
                    "eventTime": clock.advance(seconds=5),
                    "eventType": "FALLOUT_RESOLVED",
                    "processInstanceId": p_fallout,
                    "parentProcessInstanceId": p_order,
                    "processDefinitionKey": "falloutManagementBpmn",
                    "variables": {
                        "falloutId": "F-9801",
                        "failedOrderId": order_id,
                        "failedActivityId": "task_payment_auth",
                        "failedTemplateId": "TMPL_PAYMENT_AUTH",
                        "errorCode": "E_PAYMENT_AVS_MISMATCH",
                        "assignedQueue": "VIP_PAYMENT_RECOVERY_QUEUE",
                        "assignedAgent": "agent.mchen",
                        "retryCount": 2,
                        "resolutionAction": "AMENDED_VIA_CHANGE_ORDER",
                        "linkedChangeOrderId": change_id,
                        "accountId": account_id,
                        "accountType": "VIP",
                    },
                },
            ),
        ]
    )

    records.extend(
        generate_flowable_noise(
            rng=rng,
            clock=clock,
            process_instances=[
                (p_order, None, "salesOrderBpmn"),
                (p_chg, p_order, "changeOrderBpmn"),
            ],
            count=noise_per_order,
            scenario_tag="payment_change",
        )
    )
    return records


def build_port_in_enterprise_scenario(
    rng: random.Random,
    clock: EventClock,
    noise_per_order: int,
    out_of_order: bool,
    activation_fallout_only: bool = False,
) -> List[SimulatedRecord]:
    """
    Scenario 3: Enterprise Multi-Item Port-In (ACC-99401, ORD-91002)
      - Line 1 (ITM-1): Verizon Wireless (5m FOC SLA)
      - Line 2 (ITM-2): Google Voice VoIP (24h-72h FOC SLA) + deep sub-BPMN
        P-402 with NO orderId + Fallout #F-9950 (E_ESIM_PROFILE_LOCKED)
    """
    order_id = "ORD-91002"
    account_id = "ACC-99401"
    p_root = "P-400"
    p_line1 = "P-401-VZW"
    p_line2 = "P-401-GV"
    p_line2_deep = "P-402-RETRY"
    p_fallout = "P-402-F-9950"

    records: List[SimulatedRecord] = []

    if not activation_fallout_only:
        records.append(
            SimulatedRecord(
                topic="domain.order.events",
                tag="port_in:order_submitted",
                payload={
                    "eventId": new_event_id("ord"),
                    "eventTime": clock.advance(seconds=2),
                    "eventType": "ORDER_SUBMITTED",
                    "sourceSystem": "OMS-ENTERPRISE",
                    "order": {
                        "orderId": order_id,
                        "orderType": "ENTERPRISE_PORT_IN",
                        "status": "SUBMITTED",
                        "channel": "B2B_PORTAL",
                        "region": "US-CENTRAL",
                        "lineItemCount": 2,
                        "customer": {
                            "accountId": account_id,
                            "accountType": "ENTERPRISE",
                            "priorityTier": "STRATEGIC",
                            "email": "telecom-ops@acme-corp.example.com",
                        },
                        "lineItems": [
                            {
                                "lineItemId": "ITM-1",
                                "itemType": "PORT_IN_LINE",
                                "sku": "ESIM-ENT-5G-UNL",
                                "fulfillmentMethod": "DIGITAL_ESIM",
                                "status": "SUBMITTED",
                                "portIn": {
                                    "donorCarrier": "VERIZON",
                                    "portType": "WIRELESS",
                                    "mdnLast4": "8102",
                                },
                            },
                            {
                                "lineItemId": "ITM-2",
                                "itemType": "PORT_IN_LINE",
                                "sku": "ESIM-ENT-5G-UNL",
                                "fulfillmentMethod": "DIGITAL_ESIM",
                                "status": "SUBMITTED",
                                "portIn": {
                                    "donorCarrier": "GOOGLE_VOICE",
                                    "portType": "VOIP_WIRELINE",
                                    "mdnLast4": "4479",
                                },
                            },
                        ],
                    },
                },
            )
        )

    evt_root = SimulatedRecord(
        topic="flowable.activity.events",
        tag="port_in:flowable_root",
        payload={
            "eventId": new_event_id("flw"),
            "eventTime": clock.advance(seconds=1),
            "eventType": "PROCESS_STARTED",
            "processInstanceId": p_root,
            "parentProcessInstanceId": None,
            "processDefinitionKey": "salesOrderBpmn",
            "activityId": "start_enterprise_port",
            "activityName": "Start Enterprise Port-In",
            "activityType": "serviceTask",
            "variables": {
                "orderId": order_id,
                "orderType": "ENTERPRISE_PORT_IN",
                "accountId": account_id,
                "accountType": "ENTERPRISE",
            },
        },
    )
    evt_line1_sub = SimulatedRecord(
        topic="flowable.activity.events",
        tag="port_in:flowable_line1_verizon",
        payload={
            "eventId": new_event_id("flw"),
            "eventTime": clock.advance(seconds=1),
            "eventType": "PROCESS_STARTED",
            "processInstanceId": p_line1,
            "parentProcessInstanceId": p_root,
            "processDefinitionKey": "portInSubBpmn",
            "activityId": "task_port_foc_request",
            "activityName": "Port-In Sub-BPMN (Verizon)",
            "activityType": "callActivity",
            "variables": {
                "orderId": order_id,
                "orderItemId": "ITM-1",
                "orderType": "ENTERPRISE_PORT_IN",
                "donorCarrier": "VERIZON",
                "portType": "WIRELESS",
                "accountId": account_id,
                "accountType": "ENTERPRISE",
            },
        },
    )
    evt_line2_sub = SimulatedRecord(
        topic="flowable.activity.events",
        tag="port_in:flowable_line2_gvoice",
        payload={
            "eventId": new_event_id("flw"),
            "eventTime": clock.advance(seconds=1),
            "eventType": "PROCESS_STARTED",
            "processInstanceId": p_line2,
            "parentProcessInstanceId": p_root,
            "processDefinitionKey": "portInSubBpmn",
            "activityId": "task_port_foc_request",
            "activityName": "Port-In Sub-BPMN (Google Voice)",
            "activityType": "callActivity",
            "variables": {
                "orderId": order_id,
                "orderItemId": "ITM-2",
                "orderType": "ENTERPRISE_PORT_IN",
                "donorCarrier": "GOOGLE_VOICE",
                "portType": "VOIP_WIRELINE",
                "accountId": account_id,
                "accountType": "ENTERPRISE",
            },
        },
    )
    # Deep child Sub-BPMN with ONLY (processInstanceId, parentProcessInstanceId), NO orderId
    evt_line2_deep = SimulatedRecord(
        topic="flowable.activity.events",
        tag="port_in:flowable_line2_deep_no_orderid",
        is_ooo_injected=out_of_order,
        payload={
            "eventId": new_event_id("flw"),
            "eventTime": clock.advance(seconds=2),
            "eventType": "ACTIVITY_STARTED",
            "processInstanceId": p_line2_deep,
            "parentProcessInstanceId": p_line2,
            "processDefinitionKey": "carrierApiRetrySubBpmn",
            "activityId": "task_poll_npac_foc",
            "activityName": "Poll NPAC VoIP Port FOC Status",
            "activityType": "serviceTask",
            "variables": {
                "npacPollAttempt": 3,
                "carrierGateway": "NEUSTAR_NPAC",
            },
        },
    )

    if out_of_order:
        records.extend([evt_line2_deep, evt_line2_sub, evt_line1_sub, evt_root])
    else:
        records.extend([evt_root, evt_line1_sub, evt_line2_sub, evt_line2_deep])

    if not activation_fallout_only:
        # Line 1 Verizon fast 5-minute FOC + eSIM activation + billing
        for evt_type, mins in [
            ("PORT_REQUEST_SUBMITTED", 0),
            ("PORT_FOC_RECEIVED", 4),
            ("ESIM_DOWNLOAD_STARTED", 1),
            ("ESIM_ACTIVATED", 2),
        ]:
            records.append(
                SimulatedRecord(
                    topic="domain.provisioning.events",
                    tag=f"port_in:line1_verizon_{evt_type.lower()}",
                    payload={
                        "eventId": new_event_id("prv"),
                        "eventTime": clock.advance(minutes=mins, seconds=10),
                        "eventType": evt_type,
                        "provisioning": {
                            "orderId": order_id,
                            "lineItemId": "ITM-1",
                            "orderType": "ENTERPRISE_PORT_IN",
                            "accountId": account_id,
                            "accountType": "ENTERPRISE",
                            "subscriberMdn": "+1-312-555-8102",
                            "imsi": "310260111222333",
                            "portAuthPin": "948201",
                            "portIn": {"donorCarrier": "VERIZON", "portType": "WIRELESS"},
                            "esim": {"smDpVendor": "THALES"},
                        },
                    },
                )
            )
        records.append(
            SimulatedRecord(
                topic="domain.billing.events",
                tag="port_in:line1_billing_sync",
                payload={
                    "eventId": new_event_id("bil"),
                    "eventTime": clock.advance(minutes=1),
                    "eventType": "BILLING_SYNC_COMPLETED",
                    "billing": {
                        "orderId": order_id,
                        "lineItemId": "ITM-1",
                        "orderType": "ENTERPRISE_PORT_IN",
                        "accountId": account_id,
                        "accountType": "ENTERPRISE",
                        "system": "AMDOCS_ENSEMBLE",
                        "cycleCode": "ENT-01",
                    },
                },
            )
        )

    # Line 2 Google Voice slow 28-hour FOC -> eSIM profile lock failure -> Fallout #F-9950 -> recovery
    records.extend(
        [
            SimulatedRecord(
                topic="domain.provisioning.events",
                tag="port_in:line2_gvoice_port_submitted",
                payload={
                    "eventId": new_event_id("prv"),
                    "eventTime": clock.advance(seconds=5),
                    "eventType": "PORT_REQUEST_SUBMITTED",
                    "provisioning": {
                        "orderId": order_id,
                        "lineItemId": "ITM-2",
                        "orderType": "ENTERPRISE_PORT_IN",
                        "accountId": account_id,
                        "accountType": "ENTERPRISE",
                        "subscriberMdn": "+1-312-555-4479",
                        "portAuthPin": "774122",
                        "portIn": {"donorCarrier": "GOOGLE_VOICE", "portType": "VOIP_WIRELINE"},
                    },
                },
            ),
            SimulatedRecord(
                topic="domain.provisioning.events",
                tag="port_in:line2_gvoice_foc_received",
                payload={
                    "eventId": new_event_id("prv"),
                    "eventTime": clock.advance(hours=28),
                    "eventType": "PORT_FOC_RECEIVED",
                    "provisioning": {
                        "orderId": order_id,
                        "lineItemId": "ITM-2",
                        "orderType": "ENTERPRISE_PORT_IN",
                        "accountId": account_id,
                        "accountType": "ENTERPRISE",
                        "portIn": {"donorCarrier": "GOOGLE_VOICE", "portType": "VOIP_WIRELINE"},
                    },
                },
            ),
            SimulatedRecord(
                topic="domain.provisioning.events",
                tag="port_in:line2_esim_failed",
                payload={
                    "eventId": new_event_id("prv"),
                    "eventTime": clock.advance(minutes=3),
                    "eventType": "ESIM_ACTIVATION_FAILED",
                    "provisioning": {
                        "orderId": order_id,
                        "lineItemId": "ITM-2",
                        "orderType": "ENTERPRISE_PORT_IN",
                        "accountId": account_id,
                        "accountType": "ENTERPRISE",
                        "errorCode": "E_ESIM_PROFILE_LOCKED",
                        "portIn": {"donorCarrier": "GOOGLE_VOICE", "portType": "VOIP_WIRELINE"},
                        "esim": {"smDpVendor": "GD_MOBILE"},
                    },
                },
            ),
            # Fallout Management BPMN #F-9950 lifecycle
            SimulatedRecord(
                topic="flowable.fallout.events",
                tag="port_in:fallout_f9950_opened",
                payload={
                    "eventId": new_event_id("flt"),
                    "eventTime": clock.advance(seconds=4),
                    "eventType": "FALLOUT_OPENED",
                    "processInstanceId": p_fallout,
                    "parentProcessInstanceId": p_line2,
                    "processDefinitionKey": "falloutManagementBpmn",
                    "variables": {
                        "falloutId": "F-9950",
                        "failedOrderId": order_id,
                        "failedOrderItemId": "ITM-2",
                        "failedActivityId": "task_esim_activation",
                        "failedTemplateId": "TMPL_ESIM_ACTIVATION",
                        "errorCode": "E_ESIM_PROFILE_LOCKED",
                        "errorMessage": "SM-DP+ returned EID profile lock on target enterprise handset",
                        "severity": "CRITICAL",
                        "assignedQueue": "ESIM_NETWORK_OPS_L2",
                        "retryCount": 1,
                        "accountId": account_id,
                        "accountType": "ENTERPRISE",
                    },
                },
            ),
            SimulatedRecord(
                topic="flowable.fallout.events",
                tag="port_in:fallout_f9950_in_queue",
                payload={
                    "eventId": new_event_id("flt"),
                    "eventTime": clock.advance(minutes=4),
                    "eventType": "FALLOUT_IN_QUEUE",
                    "processInstanceId": p_fallout,
                    "parentProcessInstanceId": p_line2,
                    "processDefinitionKey": "falloutManagementBpmn",
                    "variables": {
                        "falloutId": "F-9950",
                        "failedOrderId": order_id,
                        "failedOrderItemId": "ITM-2",
                        "failedActivityId": "task_esim_activation",
                        "failedTemplateId": "TMPL_ESIM_ACTIVATION",
                        "errorCode": "E_ESIM_PROFILE_LOCKED",
                        "assignedQueue": "ESIM_NETWORK_OPS_L2",
                        "assignedAgent": "sre.kpatel",
                        "retryCount": 1,
                        "accountId": account_id,
                        "accountType": "ENTERPRISE",
                    },
                },
            ),
            SimulatedRecord(
                topic="flowable.fallout.events",
                tag="port_in:fallout_f9950_retrying",
                payload={
                    "eventId": new_event_id("flt"),
                    "eventTime": clock.advance(minutes=6),
                    "eventType": "FALLOUT_RETRY_TRIGGERED",
                    "processInstanceId": p_fallout,
                    "parentProcessInstanceId": p_line2,
                    "processDefinitionKey": "falloutManagementBpmn",
                    "variables": {
                        "falloutId": "F-9950",
                        "failedOrderId": order_id,
                        "failedOrderItemId": "ITM-2",
                        "failedActivityId": "task_esim_activation",
                        "failedTemplateId": "TMPL_ESIM_ACTIVATION",
                        "errorCode": "E_ESIM_PROFILE_LOCKED",
                        "assignedQueue": "ESIM_NETWORK_OPS_L2",
                        "assignedAgent": "sre.kpatel",
                        "retryCount": 2,
                        "accountId": account_id,
                        "accountType": "ENTERPRISE",
                    },
                },
            ),
            SimulatedRecord(
                topic="domain.provisioning.events",
                tag="port_in:line2_esim_activated",
                payload={
                    "eventId": new_event_id("prv"),
                    "eventTime": clock.advance(minutes=2),
                    "eventType": "ESIM_ACTIVATED",
                    "provisioning": {
                        "orderId": order_id,
                        "lineItemId": "ITM-2",
                        "orderType": "ENTERPRISE_PORT_IN",
                        "accountId": account_id,
                        "accountType": "ENTERPRISE",
                        "portIn": {"donorCarrier": "GOOGLE_VOICE", "portType": "VOIP_WIRELINE"},
                        "esim": {"smDpVendor": "GD_MOBILE"},
                    },
                },
            ),
            SimulatedRecord(
                topic="flowable.fallout.events",
                tag="port_in:fallout_f9950_resolved",
                payload={
                    "eventId": new_event_id("flt"),
                    "eventTime": clock.advance(seconds=10),
                    "eventType": "FALLOUT_RESOLVED",
                    "processInstanceId": p_fallout,
                    "parentProcessInstanceId": p_line2,
                    "processDefinitionKey": "falloutManagementBpmn",
                    "variables": {
                        "falloutId": "F-9950",
                        "failedOrderId": order_id,
                        "failedOrderItemId": "ITM-2",
                        "failedActivityId": "task_esim_activation",
                        "failedTemplateId": "TMPL_ESIM_ACTIVATION",
                        "errorCode": "E_ESIM_PROFILE_LOCKED",
                        "assignedQueue": "ESIM_NETWORK_OPS_L2",
                        "assignedAgent": "sre.kpatel",
                        "retryCount": 2,
                        "resolutionAction": "SMDP_PROFILE_RELEASED_AND_RETRIED",
                        "accountId": account_id,
                        "accountType": "ENTERPRISE",
                    },
                },
            ),
        ]
    )

    records.extend(
        generate_flowable_noise(
            rng=rng,
            clock=clock,
            process_instances=[
                (p_root, None, "salesOrderBpmn"),
                (p_line1, p_root, "portInSubBpmn"),
                (p_line2, p_root, "portInSubBpmn"),
                (p_line2_deep, p_line2, "carrierApiRetrySubBpmn"),
            ],
            count=noise_per_order,
            scenario_tag="port_in_enterprise",
        )
    )
    return records


def build_post_sales_tradein_fail_scenario(
    rng: random.Random,
    clock: EventClock,
    noise_per_order: int,
) -> List[SimulatedRecord]:
    """
    Scenario 4: Post-Sales 60-Day Trade-In Failure (TRD-55091 bundled with ORD-88412)
      Device arrives at warehouse on day 19 -> Find-My-Device lock fails
      inspection (E_TRADEIN_FMD_LOCKED) -> Fallout #F-9988 -> Waiver & Bill Credit.
    """
    order_id = "ORD-88412"
    tradein_id = "TRD-55091"
    account_id = "ACC-88412"
    p_tradein = "P-TRD-200"
    p_fallout = "P-TRD-F-9988"

    records: List[SimulatedRecord] = [
        SimulatedRecord(
            topic="domain.fulfillment.events",
            tag="tradein_fail:device_received",
            payload={
                "eventId": new_event_id("ful"),
                "eventTime": clock.advance(days=19),
                "eventType": "TRADEIN_DEVICE_RECEIVED",
                "fulfillment": {
                    "tradeInOrderId": tradein_id,
                    "orderId": order_id,
                    "orderType": "DEVICE_TRADE_IN",
                    "accountId": account_id,
                    "accountType": "VIP",
                    "carrier": "UPS",
                    "warehouseId": "WH-IND-04",
                },
            },
        ),
        SimulatedRecord(
            topic="domain.fulfillment.events",
            tag="tradein_fail:inspection_started",
            payload={
                "eventId": new_event_id("ful"),
                "eventTime": clock.advance(hours=6),
                "eventType": "TRADEIN_INSPECTION_STARTED",
                "fulfillment": {
                    "tradeInOrderId": tradein_id,
                    "orderId": order_id,
                    "orderType": "DEVICE_TRADE_IN",
                    "accountId": account_id,
                    "accountType": "VIP",
                    "warehouseId": "WH-IND-04",
                    "inspection": {"grade": "PENDING"},
                },
            },
        ),
        SimulatedRecord(
            topic="domain.fulfillment.events",
            tag="tradein_fail:inspection_failed",
            payload={
                "eventId": new_event_id("ful"),
                "eventTime": clock.advance(hours=2),
                "eventType": "TRADEIN_INSPECTION_FAILED",
                "fulfillment": {
                    "tradeInOrderId": tradein_id,
                    "orderId": order_id,
                    "orderType": "DEVICE_TRADE_IN",
                    "accountId": account_id,
                    "accountType": "VIP",
                    "warehouseId": "WH-IND-04",
                    "exceptionCode": "E_TRADEIN_FMD_LOCKED",
                    "inspection": {"grade": "LOCKED_FMD"},
                },
            },
        ),
        SimulatedRecord(
            topic="flowable.fallout.events",
            tag="tradein_fail:fallout_f9988_opened",
            payload={
                "eventId": new_event_id("flt"),
                "eventTime": clock.advance(minutes=1),
                "eventType": "FALLOUT_OPENED",
                "processInstanceId": p_fallout,
                "parentProcessInstanceId": p_tradein,
                "processDefinitionKey": "falloutManagementBpmn",
                "variables": {
                    "falloutId": "F-9988",
                    "failedEntityKey": tradein_id,
                    "failedActivityId": "task_tradein_inspection",
                    "failedTemplateId": "TMPL_INSPECTION",
                    "errorCode": "E_TRADEIN_FMD_LOCKED",
                    "errorMessage": "Google Pixel 10 Pro still has Factory Reset Protection / Find My Device enabled",
                    "severity": "MEDIUM",
                    "assignedQueue": "TRADEIN_INSPECTION_OPS",
                    "retryCount": 1,
                    "accountId": account_id,
                    "accountType": "VIP",
                },
            },
        ),
        SimulatedRecord(
            topic="flowable.fallout.events",
            tag="tradein_fail:fallout_f9988_resolved",
            payload={
                "eventId": new_event_id("flt"),
                "eventTime": clock.advance(hours=14),
                "eventType": "FALLOUT_RESOLVED",
                "processInstanceId": p_fallout,
                "parentProcessInstanceId": p_tradein,
                "processDefinitionKey": "falloutManagementBpmn",
                "variables": {
                    "falloutId": "F-9988",
                    "failedEntityKey": tradein_id,
                    "failedActivityId": "task_tradein_inspection",
                    "failedTemplateId": "TMPL_INSPECTION",
                    "errorCode": "E_TRADEIN_FMD_LOCKED",
                    "assignedQueue": "TRADEIN_INSPECTION_OPS",
                    "assignedAgent": "ops.dgarcia",
                    "retryCount": 2,
                    "resolutionAction": "CUSTOMER_REMOTE_UNLOCK_VERIFIED",
                    "accountId": account_id,
                    "accountType": "VIP",
                },
            },
        ),
        SimulatedRecord(
            topic="domain.fulfillment.events",
            tag="tradein_fail:inspection_passed",
            payload={
                "eventId": new_event_id("ful"),
                "eventTime": clock.advance(minutes=30),
                "eventType": "TRADEIN_INSPECTION_PASSED",
                "fulfillment": {
                    "tradeInOrderId": tradein_id,
                    "orderId": order_id,
                    "orderType": "DEVICE_TRADE_IN",
                    "accountId": account_id,
                    "accountType": "VIP",
                    "warehouseId": "WH-IND-04",
                    "inspection": {"grade": "GRADE_A"},
                },
            },
        ),
        SimulatedRecord(
            topic="domain.billing.events",
            tag="tradein_fail:credit_applied",
            payload={
                "eventId": new_event_id("bil"),
                "eventTime": clock.advance(hours=2),
                "eventType": "TRADEIN_CREDIT_APPLIED",
                "billing": {
                    "tradeInOrderId": tradein_id,
                    "orderId": order_id,
                    "orderType": "DEVICE_TRADE_IN",
                    "accountId": account_id,
                    "accountType": "VIP",
                    "system": "AMDOCS_ENSEMBLE",
                    "cycleCode": "CYCLE-15",
                    "creditAmountUsd": "650.00",
                },
            },
        ),
    ]

    records.extend(
        generate_flowable_noise(
            rng=rng,
            clock=clock,
            process_instances=[(p_tradein, None, "tradeInMainBpmn")],
            count=max(20, noise_per_order // 2),
            scenario_tag="tradein_fail",
        )
    )
    return records


def build_poison_pill_record() -> SimulatedRecord:
    """Deliberately malformed JSON bytes to verify Flink Stage 1 -> jeopardy.dlq.parse-errors."""
    malformed = (
        b'{"eventId":"evt-poison-pill-001","eventType":"ORDER_SUBMITTED",'
        b'"order":{"orderId":"ORD-POISON-999","brokenField": UNQUOTED_INVALID_JSON'
    )
    return SimulatedRecord(
        topic="domain.order.events",
        raw_bytes=malformed,
        is_poison_pill=True,
        tag="poison_pill:malformed_json",
    )


def build_scenario_records(args: argparse.Namespace) -> List[SimulatedRecord]:
    rng = random.Random(args.seed)
    clock = EventClock()
    records: List[SimulatedRecord] = []

    scenario = args.scenario
    if scenario == "happy":
        records.extend(
            build_happy_iphone_upgrade_scenario(rng, clock, args.noise_per_order, args.out_of_order)
        )
    elif scenario == "payment-change":
        records.extend(
            build_payment_change_scenario(rng, clock, args.noise_per_order, args.out_of_order)
        )
    elif scenario == "activation-fallout":
        records.extend(
            build_port_in_enterprise_scenario(
                rng, clock, args.noise_per_order, args.out_of_order, activation_fallout_only=True
            )
        )
    elif scenario == "post-sales-tradein-fail":
        records.extend(build_post_sales_tradein_fail_scenario(rng, clock, args.noise_per_order))
    elif scenario == "port-in-enterprise":
        records.extend(
            build_port_in_enterprise_scenario(
                rng, clock, args.noise_per_order, args.out_of_order, activation_fallout_only=False
            )
        )
    elif scenario == "all":
        records.extend(
            build_happy_iphone_upgrade_scenario(rng, clock, args.noise_per_order, args.out_of_order)
        )
        records.extend(
            build_payment_change_scenario(rng, clock, args.noise_per_order, args.out_of_order)
        )
        records.extend(
            build_port_in_enterprise_scenario(
                rng, clock, args.noise_per_order, args.out_of_order, activation_fallout_only=False
            )
        )
        records.extend(build_post_sales_tradein_fail_scenario(rng, clock, args.noise_per_order))
    elif scenario == "burst":
        # Generate burst_orders realistic multi-domain orders (1,000+ events easily)
        for idx in range(1, args.burst_orders + 1):
            records.extend(
                build_happy_iphone_upgrade_scenario(
                    rng=rng,
                    clock=clock,
                    noise_per_order=args.noise_per_order,
                    out_of_order=args.out_of_order and (idx % 3 == 0),
                    order_id=f"ORD-BURST-{80000 + idx}",
                    account_id=f"ACC-BURST-{50000 + idx}",
                    tradein_id=f"TRD-BURST-{60000 + idx}",
                    promo_id=f"INS-BURST-{70000 + idx}",
                    proc_prefix=f"PB{idx}",
                )
            )
        records.extend(build_payment_change_scenario(rng, clock, args.noise_per_order, args.out_of_order))
        records.extend(
            build_port_in_enterprise_scenario(
                rng, clock, args.noise_per_order, args.out_of_order, activation_fallout_only=False
            )
        )
    elif scenario == "scale-50-items":
        records.extend(iter_scale_50_items_records(args, rng, clock))

    if args.include_poison_pill and scenario != "scale-50-items":
        records.append(build_poison_pill_record())

    return records


def iter_scale_50_items_records(
    args: argparse.Namespace,
    rng: random.Random,
    clock: EventClock,
    stats_out: Optional[Dict[str, Any]] = None,
) -> Iterator[SimulatedRecord]:
    """
    O(1)-memory streaming generator for high-volume telecom E2E & load testing across:
      - Order Types: `SALES` and `CHANGE`
      - All 50 Order Item Types (`CHANGE_ESIM`, `CHANGE_PLAN`, `SALES_HANDSET_SHIP`, ...)
      - Multi-item 1-to-N fan-out (1..max_items_per_order items per order)
      - Nested Flowable BPMN + configurable ~95% micro-event noise + Fallout overlays
    Guarantees all 50 item types are emitted round-robin first before weighted random sampling.
    """
    sales_catalog = [s for s in CATALOG_50_ITEMS if s.order_type == "SALES"]
    change_catalog = [s for s in CATALOG_50_ITEMS if s.order_type == "CHANGE"]
    account_types = ("CONSUMER", "CONSUMER", "VIP", "SMB", "ENTERPRISE", "GOV")
    channels = ("WEB", "MOBILE_APP", "RETAIL", "CARE_AGENT", "API_PARTNER")
    regions = ("US-WEST", "US-EAST", "US-CENTRAL", "US-SOUTH")
    donors = ("VERIZON", "ATT", "TMOBILE", "GOOGLE_VOICE", "COMCAST_XFINITY")
    carriers = ("UPS", "FEDEX", "USPS")
    devices = ("iPhone 18 Pro", "Google Pixel 10 Pro", "Samsung Galaxy S26 Ultra", "Apple Watch Ultra 3", "5G Home Gateway")

    # Round-robin queue ensures 50/50 distinct item types are covered as long as total items >= 50
    pending_sales = list(sales_catalog)
    pending_change = list(change_catalog)

    distinct_items_emitted: set[str] = set()
    orders_by_type: Dict[str, int] = collections.Counter()
    items_by_type: Dict[str, int] = collections.Counter()
    fallouts_injected = 0

    run_tag = uuid.uuid4().hex[:5].upper()
    total_orders = max(1, int(args.orders))
    max_items = max(1, int(args.max_items_per_order))
    sales_ratio = min(1.0, max(0.0, float(args.sales_ratio)))
    fallout_rate = min(1.0, max(0.0, float(args.fallout_rate)))

    for idx in range(1, total_orders + 1):
        # Per-order recent clock (within last 1-4 hours) so all orders land inside live 24h dashboards!
        order_start = datetime.now(timezone.utc) - timedelta(minutes=rng.randint(20, 240))
        clock = EventClock(order_start)

        # Pick order_type ensuring both pending SALES and CHANGE catalogs drain first
        if pending_sales and not pending_change:
            order_type = "SALES"
        elif pending_change and not pending_sales:
            order_type = "CHANGE"
        elif pending_sales and pending_change:
            order_type = "SALES" if (idx % 2 == 1) else "CHANGE"
        else:
            order_type = "SALES" if rng.random() < sales_ratio else "CHANGE"

        orders_by_type[order_type] += 1
        order_prefix = "SLS" if order_type == "SALES" else "CHG"
        order_id = f"{order_prefix}-{run_tag}-{idx:05d}"
        account_id = f"ACC-SIM-{(idx % 500) + 1000}"
        account_type = rng.choice(account_types)
        channel = rng.choice(channels)
        region = rng.choice(regions)
        priority_tier = "PLATINUM" if account_type in ("VIP", "ENTERPRISE") else "STANDARD"
        p_root = f"P-{run_tag}-{idx}"
        proc_instances: List[Tuple[str, Optional[str], str]] = [
            (p_root, None, "salesMainBpmn" if order_type == "SALES" else "changeMainBpmn")
        ]

        # Select 1..max_items line items of the chosen order_type
        item_count = rng.randint(1, max_items)
        chosen_specs: List[ItemTypeSpec] = []
        pool = pending_sales if order_type == "SALES" else pending_change
        full_pool = sales_catalog if order_type == "SALES" else change_catalog
        for _ in range(item_count):
            spec = pool.pop(0) if pool else rng.choice(full_pool)
            chosen_specs.append(spec)
            distinct_items_emitted.add(spec.item_type)
            items_by_type[spec.item_type] += 1

        line_items_payload: List[Dict[str, Any]] = []
        for item_idx, spec in enumerate(chosen_specs, start=1):
            line_id = f"ITM-{item_idx}"
            item_entry: Dict[str, Any] = {
                "lineItemId": line_id,
                "itemType": spec.item_type,
                "sku": f"SKU-{spec.item_type[:12]}-{100 + item_idx}",
                "deviceModel": rng.choice(devices),
                "fulfillmentMethod": "SHIP_TO_HOME" if spec.archetype == "DEVICE_SHIP" else "DIGITAL",
                "status": "SUBMITTED",
            }
            if spec.archetype == "PORT_IN":
                item_entry["portIn"] = {
                    "donorCarrier": rng.choice(donors),
                    "portType": "WIRELESS" if "WIRELESS" in spec.item_type else "WIRELINE",
                    "mdnLast4": f"{rng.randint(1000, 9999)}",
                }
            line_items_payload.append(item_entry)

        # 1. Order Submitted (1-to-N fan-out creates 1 Root Order + N Order Items!)
        order_event_type = "ORDER_SUBMITTED" if order_type == "SALES" else "CHANGE_ORDER_CREATED"
        yield SimulatedRecord(
            topic="domain.order.events",
            tag=f"scale:{order_type}:submitted",
            payload={
                "eventId": new_event_id("ord"),
                "eventTime": clock.advance(seconds=1),
                "eventType": order_event_type,
                "sourceSystem": "OMS-CORE",
                "order": {
                    "orderId": order_id,
                    "orderType": order_type,
                    "status": "IN_PROGRESS",
                    "channel": channel,
                    "region": region,
                    "storeId": f"STR-{rng.randint(100, 999)}",
                    "lineItemCount": len(line_items_payload),
                    "customer": {
                        "accountId": account_id,
                        "accountType": account_type,
                        "priorityTier": priority_tier,
                        "ssn": "123-45-6789",
                        "email": f"user{idx}@example.com",
                        "phoneNumber": "555-019-2834",
                    },
                    "payment": {
                        "cardNumber": "4111-1111-1111-4242",
                        "cvv": "999",
                        "billingZip": "94105",
                    },
                    "shippingAddress": {"streetLine1": "100 Market St"},
                    "lineItems": line_items_payload,
                },
            },
        )

        # 2. Root Flowable PROCESS_STARTED + Item Sub-BPMNs (with optional OOO inversion)
        root_proc_rec = SimulatedRecord(
            topic="flowable.activity.events",
            tag=f"scale:{order_type}:proc_start",
            payload={
                "eventId": new_event_id("flw"),
                "eventTime": clock.advance(seconds=1),
                "eventType": "PROCESS_STARTED",
                "processInstanceId": p_root,
                "parentProcessInstanceId": None,
                "processDefinitionKey": "salesMainBpmn" if order_type == "SALES" else "changeMainBpmn",
                "activityId": "start_order_flow",
                "activityType": "startEvent",
                "variables": {
                    "orderId": order_id,
                    "orderType": order_type,
                    "accountId": account_id,
                    "accountType": account_type,
                },
            },
        )
        ooo_this_order = bool(args.out_of_order and idx % 10 == 0)
        if not ooo_this_order:
            yield root_proc_rec

        # 3. Root Fraud & Payment for SALES orders
        if order_type == "SALES":
            yield SimulatedRecord(
                topic="domain.fraud.events",
                tag="scale:fraud",
                payload={
                    "eventId": new_event_id("frd"),
                    "eventTime": clock.advance(seconds=1),
                    "eventType": "FRAUD_CHECK_APPROVED",
                    "fraud": {
                        "orderId": order_id,
                        "orderType": order_type,
                        "accountId": account_id,
                        "accountType": account_type,
                        "provider": "LEXISNEXIS",
                        "riskBand": "LOW",
                        "applicantSsn": "123-45-6789",
                    },
                },
            )
            yield SimulatedRecord(
                topic="domain.payment.events",
                tag="scale:payment",
                payload={
                    "eventId": new_event_id("pay"),
                    "eventTime": clock.advance(seconds=1),
                    "eventType": "PAYMENT_AUTH_CAPTURED",
                    "payment": {
                        "orderId": order_id,
                        "orderType": order_type,
                        "accountId": account_id,
                        "accountType": account_type,
                        "gateway": "ADYEN",
                        "methodType": "CREDIT_CARD",
                        "currency": "USD",
                        "cardNumber": "4111-1111-1111-4242",
                        "cvv": "999",
                    },
                },
            )

        # 4. Per-Item Archetype Domain Events + Optional Fallout Overlay
        all_items_completed = True
        for item_idx, spec in enumerate(chosen_specs, start=1):
            line_id = f"ITM-{item_idx}"
            p_item = f"{p_root}-I{item_idx}"
            proc_instances.append((p_item, p_root, f"item_{spec.archetype.lower()}_bpmn"))

            yield SimulatedRecord(
                topic="flowable.activity.events",
                tag=f"scale:{spec.item_type}:sub_proc",
                is_ooo_injected=ooo_this_order,
                payload={
                    "eventId": new_event_id("flw"),
                    "eventTime": clock.advance(seconds=1),
                    "eventType": "PROCESS_STARTED",
                    "processInstanceId": p_item,
                    "parentProcessInstanceId": p_root,
                    "processDefinitionKey": f"item_{spec.archetype.lower()}_bpmn",
                    "activityId": "start_item_flow",
                    "activityType": "startEvent",
                    "variables": {
                        "orderId": order_id,
                        "orderItemId": line_id,
                        "orderType": order_type,
                        "itemType": spec.item_type,
                        "accountId": account_id,
                        "accountType": account_type,
                    },
                },
            )

            hit_fallout = rng.random() < fallout_rate
            a = spec.archetype
            failed_tmpl = "TMPL_ESIM_ACTIVATION"
            failed_act = "task_esim_activation"

            if a == "DEVICE_SHIP":
                failed_tmpl, failed_act = "TMPL_FULFILLMENT_SHIP", "task_warehouse_pick"
                yield SimulatedRecord(
                    topic="domain.fulfillment.events",
                    tag=f"scale:{spec.item_type}:pick",
                    payload={
                        "eventId": new_event_id("ful"),
                        "eventTime": clock.advance(seconds=2),
                        "eventType": "WAREHOUSE_PICK_STARTED",
                        "fulfillment": {
                            "orderId": order_id,
                            "lineItemId": line_id,
                            "orderType": order_type,
                            "accountId": account_id,
                            "accountType": account_type,
                            "carrier": rng.choice(carriers),
                            "warehouseId": f"WH-US-0{rng.randint(1, 5)}",
                        },
                    },
                )
                if not hit_fallout:
                    yield SimulatedRecord(
                        topic="domain.fulfillment.events",
                        tag=f"scale:{spec.item_type}:delivered",
                        payload={
                            "eventId": new_event_id("ful"),
                            "eventTime": clock.advance(minutes=45),
                            "eventType": "SHIPMENT_DELIVERED",
                            "fulfillment": {
                                "orderId": order_id,
                                "lineItemId": line_id,
                                "orderType": order_type,
                                "accountId": account_id,
                                "accountType": account_type,
                                "carrier": rng.choice(carriers),
                                "warehouseId": f"WH-US-0{rng.randint(1, 5)}",
                            },
                        },
                    )
                    yield SimulatedRecord(
                        topic="domain.provisioning.events",
                        tag=f"scale:{spec.item_type}:esim",
                        payload={
                            "eventId": new_event_id("prv"),
                            "eventTime": clock.advance(seconds=30),
                            "eventType": "ESIM_ACTIVATED",
                            "provisioning": {
                                "orderId": order_id,
                                "lineItemId": line_id,
                                "orderType": order_type,
                                "accountId": account_id,
                                "accountType": account_type,
                                "esim": {"smDpVendor": "THALES"},
                            },
                        },
                    )
            elif a == "PORT_IN":
                failed_tmpl, failed_act = "TMPL_PORT_FOC", "task_port_foc_request"
                donor = rng.choice(donors)
                yield SimulatedRecord(
                    topic="domain.provisioning.events",
                    tag=f"scale:{spec.item_type}:port_sub",
                    payload={
                        "eventId": new_event_id("prv"),
                        "eventTime": clock.advance(seconds=2),
                        "eventType": "PORT_REQUEST_SUBMITTED",
                        "provisioning": {
                            "orderId": order_id,
                            "lineItemId": line_id,
                            "orderType": order_type,
                            "accountId": account_id,
                            "accountType": account_type,
                            "portIn": {"donorCarrier": donor, "portType": "WIRELESS"},
                            "portAuthPin": "994812",
                        },
                    },
                )
                if not hit_fallout:
                    yield SimulatedRecord(
                        topic="domain.provisioning.events",
                        tag=f"scale:{spec.item_type}:port_foc",
                        payload={
                            "eventId": new_event_id("prv"),
                            "eventTime": clock.advance(minutes=5 if donor == "VERIZON" else 90),
                            "eventType": "PORT_FOC_RECEIVED",
                            "provisioning": {
                                "orderId": order_id,
                                "lineItemId": line_id,
                                "orderType": order_type,
                                "accountId": account_id,
                                "accountType": account_type,
                                "portIn": {"donorCarrier": donor, "portType": "WIRELESS"},
                            },
                        },
                    )
                    yield SimulatedRecord(
                        topic="domain.provisioning.events",
                        tag=f"scale:{spec.item_type}:esim",
                        payload={
                            "eventId": new_event_id("prv"),
                            "eventTime": clock.advance(seconds=20),
                            "eventType": "ESIM_ACTIVATED",
                            "provisioning": {
                                "orderId": order_id,
                                "lineItemId": line_id,
                                "orderType": order_type,
                                "accountId": account_id,
                                "accountType": account_type,
                                "esim": {"smDpVendor": "IDEMIA"},
                            },
                        },
                    )
            elif a in ("DIGITAL_ESIM", "ACCOUNT_LIFECYCLE"):
                failed_tmpl, failed_act = "TMPL_ESIM_ACTIVATION", "task_esim_activation"
                yield SimulatedRecord(
                    topic="domain.provisioning.events",
                    tag=f"scale:{spec.item_type}:esim_start",
                    payload={
                        "eventId": new_event_id("prv"),
                        "eventTime": clock.advance(seconds=2),
                        "eventType": "ESIM_DOWNLOAD_STARTED",
                        "provisioning": {
                            "orderId": order_id,
                            "lineItemId": line_id,
                            "orderType": order_type,
                            "accountId": account_id,
                            "accountType": account_type,
                            "esim": {"smDpVendor": "THALES"},
                        },
                    },
                )
                if not hit_fallout:
                    yield SimulatedRecord(
                        topic="domain.provisioning.events",
                        tag=f"scale:{spec.item_type}:esim_ok",
                        payload={
                            "eventId": new_event_id("prv"),
                            "eventTime": clock.advance(seconds=25),
                            "eventType": "ESIM_ACTIVATED",
                            "provisioning": {
                                "orderId": order_id,
                                "lineItemId": line_id,
                                "orderType": order_type,
                                "accountId": account_id,
                                "accountType": account_type,
                                "esim": {"smDpVendor": "THALES"},
                            },
                        },
                    )
            elif a == "PARTNER_PERK":
                failed_tmpl, failed_act = "TMPL_PARTNER_ENROLL", "task_partner_insurance_enroll"
                yield SimulatedRecord(
                    topic="domain.provisioning.events",
                    tag=f"scale:{spec.item_type}:partner_sub",
                    payload={
                        "eventId": new_event_id("prv"),
                        "eventTime": clock.advance(seconds=2),
                        "eventType": "PARTNER_PROMO_SUBMITTED",
                        "provisioning": {
                            "orderId": order_id,
                            "lineItemId": line_id,
                            "orderType": order_type,
                            "accountId": account_id,
                            "accountType": account_type,
                            "partner": {"partnerName": "ASSURANT"},
                        },
                    },
                )
                if not hit_fallout:
                    yield SimulatedRecord(
                        topic="domain.provisioning.events",
                        tag=f"scale:{spec.item_type}:partner_ok",
                        payload={
                            "eventId": new_event_id("prv"),
                            "eventTime": clock.advance(seconds=15),
                            "eventType": "PARTNER_PROMO_ENROLLED",
                            "provisioning": {
                                "orderId": order_id,
                                "lineItemId": line_id,
                                "orderType": order_type,
                                "accountId": account_id,
                                "accountType": account_type,
                                "partner": {"partnerName": "ASSURANT"},
                            },
                        },
                    )
            elif a == "TRADE_IN":
                failed_tmpl, failed_act = "TMPL_INSPECTION", "task_tradein_inspection"
                yield SimulatedRecord(
                    topic="domain.fulfillment.events",
                    tag=f"scale:{spec.item_type}:kit",
                    payload={
                        "eventId": new_event_id("ful"),
                        "eventTime": clock.advance(seconds=2),
                        "eventType": "TRADEIN_KIT_SHIPPED",
                        "fulfillment": {
                            "orderId": order_id,
                            "lineItemId": line_id,
                            "orderType": order_type,
                            "accountId": account_id,
                            "accountType": account_type,
                            "carrier": "UPS",
                            "warehouseId": "WH-IND-04",
                        },
                    },
                )
                if not hit_fallout:
                    yield SimulatedRecord(
                        topic="domain.fulfillment.events",
                        tag=f"scale:{spec.item_type}:rcv",
                        payload={
                            "eventId": new_event_id("ful"),
                            "eventTime": clock.advance(hours=36),
                            "eventType": "TRADEIN_DEVICE_RECEIVED",
                            "fulfillment": {
                                "orderId": order_id,
                                "lineItemId": line_id,
                                "orderType": order_type,
                                "accountId": account_id,
                                "accountType": account_type,
                                "warehouseId": "WH-IND-04",
                            },
                        },
                    )
                    yield SimulatedRecord(
                        topic="domain.fulfillment.events",
                        tag=f"scale:{spec.item_type}:insp_ok",
                        payload={
                            "eventId": new_event_id("ful"),
                            "eventTime": clock.advance(hours=4),
                            "eventType": "TRADEIN_INSPECTION_PASSED",
                            "fulfillment": {
                                "orderId": order_id,
                                "lineItemId": line_id,
                                "orderType": order_type,
                                "accountId": account_id,
                                "accountType": account_type,
                                "warehouseId": "WH-IND-04",
                                "inspection": {"grade": "GRADE_A"},
                            },
                        },
                    )
            elif a == "PAYMENT_AMEND":
                failed_tmpl, failed_act = "TMPL_PAYMENT_AUTH", "task_payment_auth"
                yield SimulatedRecord(
                    topic="domain.payment.events",
                    tag=f"scale:{spec.item_type}:pay_amend",
                    payload={
                        "eventId": new_event_id("pay"),
                        "eventTime": clock.advance(seconds=3),
                        "eventType": "PAYMENT_AUTH_DECLINED" if hit_fallout else "PAYMENT_REAUTH_CAPTURED",
                        "payment": {
                            "orderId": order_id,
                            "orderType": order_type,
                            "accountId": account_id,
                            "accountType": account_type,
                            "gateway": "ADYEN",
                            "methodType": "CREDIT_CARD",
                            "declineCode": spec.default_error_code if hit_fallout else None,
                            "currency": "USD",
                        },
                    },
                )
            else:
                # PLAN_BILLING (e.g., CHANGE_PLAN, CHANGE_ADD_FEATURE, CHANGE_BILLING_CYCLE)
                failed_tmpl, failed_act = "TMPL_BILLING_SYNC", "task_billing_sync"
                yield SimulatedRecord(
                    topic="domain.billing.events",
                    tag=f"scale:{spec.item_type}:bill_start",
                    payload={
                        "eventId": new_event_id("bil"),
                        "eventTime": clock.advance(seconds=2),
                        "eventType": "BILLING_SYNC_STARTED",
                        "billing": {
                            "orderId": order_id,
                            "lineItemId": line_id,
                            "orderType": order_type,
                            "accountId": account_id,
                            "accountType": account_type,
                            "system": "AMDOCS_ENSEMBLE",
                            "cycleCode": "CYCLE-15",
                        },
                    },
                )

            if hit_fallout:
                all_items_completed = False
                fallouts_injected += 1
                fallout_id = f"F-{run_tag}-{idx:04d}-{item_idx}"
                p_fallout = f"PF-{run_tag}-{idx}-{item_idx}"
                yield SimulatedRecord(
                    topic="flowable.fallout.events",
                    tag=f"scale:{spec.item_type}:fallout_open",
                    payload={
                        "eventId": new_event_id("flt"),
                        "eventTime": clock.advance(seconds=2),
                        "eventType": "FALLOUT_OPENED",
                        "processInstanceId": p_fallout,
                        "parentProcessInstanceId": p_item,
                        "processDefinitionKey": "falloutManagementBpmn",
                        "variables": {
                            "falloutId": fallout_id,
                            "failedOrderId": order_id,
                            "failedOrderItemId": line_id,
                            "failedActivityId": failed_act,
                            "failedTemplateId": failed_tmpl,
                            "accountId": account_id,
                            "accountType": account_type,
                            "errorCode": spec.default_error_code,
                            "errorMessage": f"{spec.item_type} failed during {failed_act}",
                            "severity": "JEOPARDY",
                            "assignedQueue": spec.fallout_queue,
                            "retryCount": 2,
                        },
                    },
                )
                # Resolve ~40% of fallouts so ClickHouse gets MTTR while ~60% stay LIVE OPEN in PG
                if idx % 5 in (0, 1):
                    yield SimulatedRecord(
                        topic="flowable.fallout.events",
                        tag=f"scale:{spec.item_type}:fallout_resolved",
                        payload={
                            "eventId": new_event_id("flt"),
                            "eventTime": clock.advance(minutes=12),
                            "eventType": "FALLOUT_RESOLVED",
                            "processInstanceId": p_fallout,
                            "parentProcessInstanceId": p_item,
                            "processDefinitionKey": "falloutManagementBpmn",
                            "variables": {
                                "falloutId": fallout_id,
                                "failedOrderId": order_id,
                                "failedOrderItemId": line_id,
                                "failedActivityId": failed_act,
                                "failedTemplateId": failed_tmpl,
                                "accountId": account_id,
                                "accountType": account_type,
                                "errorCode": spec.default_error_code,
                                "assignedQueue": spec.fallout_queue,
                                "assignedAgent": "ops.autoretry",
                                "resolutionAction": "AUTO_RETRY_SUCCEEDED",
                                "retryCount": 3,
                            },
                        },
                    )
            else:
                # Billing Sync Completed for non-fallout item
                yield SimulatedRecord(
                    topic="domain.billing.events",
                    tag=f"scale:{spec.item_type}:bill_ok",
                    payload={
                        "eventId": new_event_id("bil"),
                        "eventTime": clock.advance(seconds=10),
                        "eventType": "BILLING_SYNC_COMPLETED",
                        "billing": {
                            "orderId": order_id,
                            "lineItemId": line_id,
                            "orderType": order_type,
                            "accountId": account_id,
                            "accountType": account_type,
                            "system": "AMDOCS_ENSEMBLE",
                            "cycleCode": "CYCLE-15",
                        },
                    },
                )

        if ooo_this_order:
            yield root_proc_rec

        # 5. Close order when all line items succeeded
        if all_items_completed:
            close_event_type = "ORDER_COMPLETED" if order_type == "SALES" else "CHANGE_ORDER_COMPLETED"
            yield SimulatedRecord(
                topic="domain.order.events",
                tag=f"scale:{order_type}:completed",
                payload={
                    "eventId": new_event_id("ord"),
                    "eventTime": clock.advance(seconds=2),
                    "eventType": close_event_type,
                    "sourceSystem": "OMS-CORE",
                    "order": {
                        "orderId": order_id,
                        "orderType": order_type,
                        "status": "COMPLETED",
                        "channel": channel,
                        "region": region,
                        "lineItemCount": len(line_items_payload),
                        "customer": {"accountId": account_id, "accountType": account_type},
                        "lineItems": [
                            {**li, "status": "COMPLETED"} for li in line_items_payload
                        ],
                    },
                },
            )

        # 6. Flowable BPMN micro-event noise per order
        for noise_rec in generate_flowable_noise(
            rng, clock, proc_instances, args.noise_per_order, f"scale-{idx}"
        ):
            yield noise_rec

    if args.include_poison_pill:
        yield build_poison_pill_record()

    if stats_out is not None:
        stats_out["orders_by_type"] = dict(orders_by_type)
        stats_out["distinct_item_types"] = len(distinct_items_emitted)
        stats_out["total_items"] = sum(items_by_type.values())
        stats_out["top_item_types"] = items_by_type.most_common(10)
        stats_out["fallouts_injected"] = fallouts_injected


def publish_stream_to_kafka(
    bootstrap_servers: str,
    record_iter: Iterator[SimulatedRecord],
    rate_per_sec: float,
    delay_ms: int,
    dry_run: bool,
) -> Dict[str, Any]:
    """O(1)-memory streaming publisher supporting 100k–1M+ events with rate limiting."""
    producer = None
    if not dry_run:
        try:
            from kafka import KafkaProducer  # type: ignore
        except ImportError as exc:
            print(
                "ERROR: kafka-python-ng is required for live Kafka publishing.\n"
                "Install it via: pip install -r tools/event-simulator/requirements.txt",
                file=sys.stderr,
            )
            raise SystemExit(2) from exc

        producer = KafkaProducer(
            bootstrap_servers=[s.strip() for s in bootstrap_servers.split(",") if s.strip()],
            acks="all",
            linger_ms=15,
            batch_size=65536,
            compression_type="gzip",
            retries=3,
        )

    by_topic: Dict[str, int] = collections.Counter()
    signal_count = 0
    noise_count = 0
    poison_count = 0
    ooo_count = 0
    total = 0
    started = time.monotonic()

    try:
        for rec in record_iter:
            if producer is not None:
                # CRITICAL GUARDRAIL: ALWAYS publish with key=None (deliberately unpartitioned!)
                producer.send(rec.topic, key=None, value=rec.serialize())

            total += 1
            by_topic[rec.topic] += 1
            if rec.is_poison_pill:
                poison_count += 1
            elif rec.is_noise:
                noise_count += 1
            else:
                signal_count += 1
            if rec.is_ooo_injected:
                ooo_count += 1

            if rate_per_sec > 0 and total % 50 == 0:
                expected_elapsed = total / rate_per_sec
                actual_elapsed = time.monotonic() - started
                if expected_elapsed > actual_elapsed:
                    time.sleep(expected_elapsed - actual_elapsed)
            elif delay_ms > 0:
                time.sleep(delay_ms / 1000.0)

        if producer is not None:
            producer.flush(timeout=60)
    finally:
        if producer is not None:
            producer.close()

    elapsed = max(0.001, time.monotonic() - started)
    return {
        "total": total,
        "signal_count": signal_count,
        "noise_count": noise_count,
        "poison_count": poison_count,
        "ooo_count": ooo_count,
        "by_topic": dict(by_topic),
        "elapsed_sec": elapsed,
        "eps": total / elapsed,
    }


def publish_to_kafka(bootstrap_servers: str, records: List[SimulatedRecord], delay_ms: int) -> None:
    try:
        from kafka import KafkaProducer  # type: ignore
    except ImportError as exc:
        print(
            "ERROR: kafka-python-ng is required for live Kafka publishing.\n"
            "Install it via: pip install -r tools/event-simulator/requirements.txt\n"
            "Or run with --dry-run to validate payloads without a Kafka broker.",
            file=sys.stderr,
        )
        raise SystemExit(2) from exc

    producer = KafkaProducer(
        bootstrap_servers=[s.strip() for s in bootstrap_servers.split(",") if s.strip()],
        acks="all",
        linger_ms=10,
        retries=3,
    )
    try:
        for rec in records:
            # CRITICAL GUARDRAIL: ALWAYS publish with key=None (deliberately unpartitioned!)
            producer.send(rec.topic, key=None, value=rec.serialize())
            if delay_ms > 0:
                time.sleep(delay_ms / 1000.0)
        producer.flush(timeout=30)
    finally:
        producer.close()


def print_summary(args: argparse.Namespace, records: List[SimulatedRecord], mode: str) -> None:
    by_topic: Dict[str, int] = collections.Counter()
    signal_count = 0
    noise_count = 0
    poison_count = 0
    ooo_count = 0
    samples_by_topic: Dict[str, SimulatedRecord] = {}

    for rec in records:
        by_topic[rec.topic] += 1
        if rec.is_poison_pill:
            poison_count += 1
        elif rec.is_noise:
            noise_count += 1
        else:
            signal_count += 1
            samples_by_topic.setdefault(rec.topic, rec)
        if rec.is_ooo_injected:
            ooo_count += 1

    total = len(records)
    noise_pct = (noise_count / total * 100.0) if total else 0.0

    print("=" * 78)
    print(f"Jeopardy Multi-Domain Kafka Simulator [{mode}]")
    print("=" * 78)
    print(f"Scenario          : {args.scenario}")
    print(f"Bootstrap Servers : {args.bootstrap_servers}")
    print(f"Kafka Key Policy  : key=None (DELIBERATELY UNPARTITIONED / round-robin)")
    print(f"Total Events      : {total} (Signal: {signal_count}, Flowable Noise: {noise_count} [{noise_pct:.1f}%])")
    print(f"Poison Pills      : {poison_count} (targets jeopardy.dlq.parse-errors)")
    print(f"OOO Inversions    : {ooo_count} (child sub-BPMN/fallout emitted before parent)")
    print("-" * 78)
    print("Events per Source Topic:")
    for topic in SOURCE_TOPICS:
        print(f"  - {topic:<30} : {by_topic.get(topic, 0):>5}")
    print("-" * 78)

    if args.dry_run:
        print("Sample Signal Payload per Topic (first signal record):")
        for topic in SOURCE_TOPICS:
            sample = samples_by_topic.get(topic)
            if not sample:
                print(f"\n[{topic}] (no events emitted for scenario '{args.scenario}')")
                continue
            print(f"\n[{topic}] tag={sample.tag} key=None")
            print(json.dumps(sample.payload, indent=2)[:700])
        if poison_count:
            pill = next(r for r in records if r.is_poison_pill)
            print(f"\n[POISON PILL -> {pill.topic}] key=None raw_bytes={pill.serialize().decode('utf-8', errors='replace')}")
    print("=" * 78)


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Local unpartitioned multi-domain Kafka payload simulator for Jeopardy Management."
    )
    parser.add_argument(
        "--bootstrap-servers",
        default="localhost:29092",
        help="Kafka bootstrap servers (default: localhost:29092)",
    )
    parser.add_argument(
        "--scenario",
        choices=[
            "happy",
            "payment-change",
            "activation-fallout",
            "post-sales-tradein-fail",
            "port-in-enterprise",
            "all",
            "burst",
            "scale-50-items",
        ],
        default="all",
        help="Simulation scenario to run (default: all; use 'scale-50-items' for SALES/CHANGE 50-item-type load testing)",
    )
    parser.add_argument(
        "--orders",
        type=int,
        default=100,
        help="Total orders to stream in --scenario scale-50-items (default: 100; supports 10,000+ in O(1) RAM)",
    )
    parser.add_argument(
        "--rate-per-sec",
        type=float,
        default=0.0,
        help="Target sustained events/sec for --scenario scale-50-items (0 = max burst speed)",
    )
    parser.add_argument(
        "--sales-ratio",
        type=float,
        default=0.55,
        help="Fraction of SALES vs CHANGE orders in --scenario scale-50-items (default: 0.55)",
    )
    parser.add_argument(
        "--fallout-rate",
        type=float,
        default=0.08,
        help="Fraction of order items hitting Fallout Management BPMN in --scenario scale-50-items (default: 0.08)",
    )
    parser.add_argument(
        "--max-items-per-order",
        type=int,
        default=3,
        help="Max line items per multi-item order in --scenario scale-50-items (default: 3)",
    )
    parser.add_argument(
        "--noise-per-order",
        type=int,
        default=120,
        help="Flowable BPMN micro-event noise records per order (default: 120; set up to 1000 for ~95%% noise)",
    )
    parser.add_argument(
        "--burst-orders",
        type=int,
        default=10,
        help="Number of orders to generate when --scenario burst (default: 10)",
    )
    parser.add_argument(
        "--include-poison-pill",
        action="store_true",
        help="Inject 1 intentionally malformed JSON payload to test jeopardy.dlq.parse-errors",
    )
    parser.add_argument(
        "--out-of-order",
        action="store_true",
        help="Deliberately send child sub-BPMN/fallout events BEFORE parent PROCESS_STARTED to test Stage 2 15s OOO buffer",
    )
    parser.add_argument(
        "--delay-ms",
        type=int,
        default=0,
        help="Optional inter-event delay in milliseconds for slow live demos (default: 0)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for reproducible simulation runs (default: 42)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and print summary stats + sample payloads without connecting to Kafka",
    )
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    if args.noise_per_order < 0:
        print("ERROR: --noise-per-order must be >= 0", file=sys.stderr)
        return 2

    if args.scenario == "scale-50-items":
        rng = random.Random(args.seed)
        clock = EventClock()
        scale_stats: Dict[str, Any] = {}
        stream = iter_scale_50_items_records(args, rng, clock, stats_out=scale_stats)
        mode = "DRY-RUN" if args.dry_run else "PUBLISHED TO KAFKA (STREAMING)"
        res = publish_stream_to_kafka(
            args.bootstrap_servers, stream, args.rate_per_sec, args.delay_ms, args.dry_run
        )
        total = res["total"]
        noise_pct = (res["noise_count"] / total * 100.0) if total else 0.0
        print("=" * 78)
        print(f"Jeopardy 50-Item-Type Volume Simulator [{mode}]")
        print("=" * 78)
        print(f"Order Types       : {scale_stats.get('orders_by_type', {})}")
        print(f"Item Coverage     : {scale_stats.get('distinct_item_types', 0)}/50 distinct item types ({scale_stats.get('total_items', 0)} total line items)")
        print(f"Fallouts Injected : {scale_stats.get('fallouts_injected', 0)}")
        print(f"Total Events      : {total:,} (Signal: {res['signal_count']:,}, Flowable Noise: {res['noise_count']:,} [{noise_pct:.1f}%])")
        print(f"Throughput        : {res['eps']:,.1f} events/sec ({res['elapsed_sec']:.2f}s elapsed) | key=None (unpartitioned)")
        print(f"Poison Pills / OOO: {res['poison_count']} poison pills | {res['ooo_count']} OOO sub-BPMN inversions")
        print("-" * 78)
        for topic in SOURCE_TOPICS:
            print(f"  - {topic:<30} : {res['by_topic'].get(topic, 0):>7,}")
        print("=" * 78)
        return 0

    records = build_scenario_records(args)
    if args.dry_run:
        print_summary(args, records, mode="DRY-RUN")
        return 0

    publish_to_kafka(args.bootstrap_servers, records, args.delay_ms)
    print_summary(args, records, mode="PUBLISHED TO KAFKA")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
