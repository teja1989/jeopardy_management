#!/usr/bin/env python3
"""
Jeopardy Management — 50,000-Order Production-Scale Live Streaming Load Simulator

Streams 50,000 tagged orders (LOAD50K-ORD-000001 .. LOAD50K-ORD-050000) across:
  - 50,000 Root Orders (SALES_UPGRADE, MOBILE_PORT_IN)
  - 60,000 Order Line Items (1-to-N forEach fan-out; 20% multi-item)
  - 17,500 Internal / Companion Orders:
      * 7,500 Free Device Insurance (INTERNAL_PROMO_PROVISIONING) — incl. OOO & missing customerId
      * 7,500 Bundled 60-Day Trade-Ins (DEVICE_TRADE_IN)
      * 2,500 Short-Lived Payment Change Orders (SUPP_PAYMENT_UPDATE -> Cross-Order SLA pause/resume)
  - ~3,500 Fallout Management BPMNs (including 500 Repeat / Boomerang Fallouts)
  - 50,000 Flowable BPMN noise events (Stage 1 O(1) noise filter proof)
  - 100 malformed Poison-Pill payloads (jeopardy.dlq.parse-errors proof)

All messages are published UNPARTITIONED (key=None) to faithfully reproduce
enterprise AWS MSK arrival skew. Clean up anytime with:
    ./tools/load-test/cleanup_50k.sh
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from kafka import KafkaProducer

PREFIX = "LOAD50K"

CHANNELS = ("WEB", "MOBILE_APP", "RETAIL", "CARE")
ACCOUNT_TYPES = ("VIP", "ENTERPRISE", "SMB", "CONSUMER")
REGIONS = ("US-WEST", "US-EAST", "US-CENTRAL", "US-SOUTH", None)  # 20% omit region intentionally
DONOR_CARRIERS = (
    ("VERIZON", "WIRELESS", 180, 480),       # 3-8 min FOC
    ("ATT", "WIRELESS", 240, 720),           # 4-12 min FOC
    ("TMOBILE", "WIRELESS", 200, 600),       # 3-10 min FOC
    ("GOOGLE_VOICE", "VOIP", 43200, 216000), # 12h-60h FOC (trains survival ML contrast!)
    ("COMCAST_VOIP", "VOIP", 28800, 172800), # 8h-48h FOC
)
FULFILLMENT_METHODS = ("SHIP_TO_HOME", "EXPRESS_AIR", "SAME_DAY_COURIER")
PRIORITY_TIERS = ("GOLD", "SILVER", "STANDARD")
FALLOUT_QUEUES = ("BILLING_OPS_L2", "PORTING_DESK", "FULFILLMENT_OPS", "PROVISIONING_SRE")
FALLOUT_ERRORS = (
    ("PAY_GATEWAY_504", "TMPL_PAYMENT_AUTH", "task_payment_auth", "BILLING_OPS_L2"),
    ("PORT_PIN_MISMATCH", "TMPL_PORT_FOC", "task_port_foc", "PORTING_DESK"),
    ("WMS_STOCK_LOCK", "TMPL_FULFILLMENT_SHIP", "task_warehouse_pick", "FULFILLMENT_OPS"),
    ("ESIM_SMDP_TIMEOUT", "TMPL_ESIM_ACTIVATION", "task_esim_activation", "PROVISIONING_SRE"),
)
NOISE_TYPES = (
    ("VARIABLE_UPDATED", "scriptTask", "updateProcessCtxVars"),
    ("SEQUENCEFLOW_TAKEN", "sequenceFlow", "flow_eval_route"),
    ("ACTIVITY_STARTED", "exclusiveGateway", "gw_route_check"),
    ("ACTIVITY_COMPLETED", "exclusiveGateway", "gw_route_check"),
    ("ENTITY_UPDATED", "parallelGateway", "gw_parallel_sync"),
)


def iso_z(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def build_order_records(
    idx: int,
    rng: random.Random,
    base_now: datetime,
    noise_per_order: int,
) -> Tuple[List[Tuple[str, bytes]], Dict[str, int]]:
    """Builds all Kafka (topic, serialized_bytes) records for one order."""
    records: List[Tuple[str, bytes]] = []
    stats = {
        "root_orders": 1,
        "order_items": 0,
        "trade_ins": 0,
        "insurances": 0,
        "change_orders": 0,
        "fallouts": 0,
        "boomerangs": 0,
        "noise": 0,
    }

    order_id = f"{PREFIX}-ORD-{idx:06d}"
    # ~10k unique customers -> realistic 5 orders/customer for Customer Orders Directory!
    account_id = f"L50K-ACC-{(idx % 10000) + 1:05d}"
    is_port_in = (idx % 20) >= 13  # 35% MOBILE_PORT_IN, 65% SALES_UPGRADE
    order_type = "MOBILE_PORT_IN" if is_port_in else "SALES_UPGRADE"
    primary_item_type = "PORT_IN_LINE" if is_port_in else "HANDSET_SHIP_TO_HOME"

    account_type = ACCOUNT_TYPES[idx % len(ACCOUNT_TYPES)]
    channel = CHANNELS[(idx // 3) % len(CHANNELS)]
    region = REGIONS[(idx // 5) % len(REGIONS)]
    priority_tier = PRIORITY_TIERS[idx % len(PRIORITY_TIERS)]
    fulfillment_method = FULFILLMENT_METHODS[idx % len(FULFILLMENT_METHODS)]

    # Spread creation timestamps smoothly across the last 72 hours for rich calendar/hourly charts!
    age_sec = rng.randint(60, 72 * 3600)
    t0 = base_now - timedelta(seconds=age_sec)

    has_second_item = (idx % 5 == 0)         # 20% multi-item -> 60,000 Order Items
    has_trade_in = (idx % 20 in (0, 6, 12))  # 15% = 7,500 Trade-Ins
    has_insurance = (idx % 20 in (1, 7, 14)) # 15% = 7,500 Free Device Insurance companions
    has_change_order = (idx % 20 == 2)       # 5%  = 2,500 Payment Change Orders

    # Lifecycle outcome bucket (deterministic across 100-order cycles)
    bucket = idx % 100
    is_completed = bucket < 65               # 65% completed
    is_in_progress = 65 <= bucket < 90       # 25% live open
    is_fallout = 90 <= bucket < 97           # 7%  fallout BPMN (3,500)
    is_domain_fail = bucket >= 97            # 3%  domain failure (1,500)

    donor_carrier, port_type, foc_min_s, foc_max_s = DONOR_CARRIERS[idx % len(DONOR_CARRIERS)]

    tradein_id = f"{PREFIX}-TRD-{idx:06d}" if has_trade_in else None
    promo_id = f"{PREFIX}-INS-{idx:06d}" if has_insurance else None
    chg_id = f"{PREFIX}-CHG-{idx:06d}" if has_change_order else None

    # Build lineItems array (1-to-N forEach fan-out in Stage 1)
    item1: Dict[str, Any] = {
        "lineItemId": "ITM-1",
        "itemType": primary_item_type,
        "status": "IN_PROGRESS",
        "sku": "SIM-PORT-5G" if is_port_in else "IPH18P-256-TI",
        "deviceModel": "BYOD-5G" if is_port_in else "iPhone 18 Pro",
        "fulfillmentMethod": fulfillment_method,
    }
    if is_port_in:
        item1["portIn"] = {
            "donorCarrier": donor_carrier,
            "portType": port_type,
            "mdnLast4": f"{idx % 10000:04d}",
        }
    if has_trade_in:
        item1["tradeIn"] = {
            "tradeInOrderId": tradein_id,
            "parentLineItemId": "ITM-1",
            "deviceModel": "Google Pixel 10 Pro",
            "quotedCreditUsd": "750",
            "returnWindowDays": "60",
            "returnKitCarrier": "UPS",
            "status": "IN_PROGRESS",
        }
        stats["trade_ins"] += 1
    if has_insurance:
        item1["autoPromos"] = [
            {
                "promoOrderId": promo_id,
                "parentLineItemId": "ITM-1",
                "promoType": "FREE_DEVICE_INSURANCE",
                "partnerName": "ASSURANT",
                "promoCode": "FREE_INS_12M",
                "benefitTermMonths": "12",
                "status": "IN_PROGRESS",
            }
        ]
        stats["insurances"] += 1

    line_items = [item1]
    stats["order_items"] += 1

    if has_second_item:
        line_items.append(
            {
                "lineItemId": "ITM-2",
                "itemType": "HANDSET_SHIP_TO_HOME",
                "status": "IN_PROGRESS",
                "sku": "AW-ULTRA-3",
                "deviceModel": "Apple Watch Ultra 3",
                "fulfillmentMethod": fulfillment_method,
            }
        )
        stats["order_items"] += 1

    order_payload: Dict[str, Any] = {
        "eventId": f"L50K-ORD-SUB-{idx}",
        "eventTime": iso_z(t0),
        "eventType": "ORDER_SUBMITTED",
        "sourceSystem": "OMS-LOAD50K",
        "order": {
            "orderId": order_id,
            "orderType": order_type,
            "status": "IN_PROGRESS",
            "channel": channel,
            "storeId": f"STR-{(idx % 120) + 1:03d}",
            "lineItemCount": str(len(line_items)),
            "customer": {
                "accountId": account_id,
                "accountType": account_type,
                "priorityTier": priority_tier,
                "email": f"user{idx}@pii-redacted.example.com",  # exercises PII redaction!
            },
            "lineItems": line_items,
        },
    }
    if region is not None:
        order_payload["order"]["region"] = region

    def emit(topic: str, obj: Dict[str, Any]) -> None:
        records.append((topic, json.dumps(obj, separators=(",", ":")).encode("utf-8")))

    # Out-of-order companion edge case: for first 500 insurance orders, emit partner promo
    # event WITHOUT accountId BEFORE the parent ORDER_SUBMITTED event!
    ooo_companion_first = has_insurance and (idx % 100 == 1)
    if ooo_companion_first and promo_id:
        emit(
            "domain.provisioning.events",
            {
                "eventId": f"L50K-PROMO-OOO-{idx}",
                "eventTime": iso_z(t0 - timedelta(seconds=2)),
                "eventType": "PARTNER_PROMO_SUBMITTED",
                "provisioning": {
                    "promoOrderId": promo_id,
                    "orderType": "INTERNAL_PROMO_PROVISIONING",
                    # Deliberately omit accountId to test 1-hop relationship stitching!
                    "partner": {"partnerName": "ASSURANT"},
                },
            },
        )

    # 1. Emit ORDER_SUBMITTED (fans out Root Order + Line Items + Trade-In + Insurance)
    emit("domain.order.events", order_payload)

    # 2. Fraud Check (Root Order)
    t_fraud_s = t0 + timedelta(seconds=2)
    t_fraud_e = t_fraud_s + timedelta(seconds=rng.randint(8, 45))
    emit(
        "domain.fraud.events",
        {
            "eventId": f"L50K-FRD-S-{idx}",
            "eventTime": iso_z(t_fraud_s),
            "eventType": "FRAUD_CHECK_STARTED",
            "fraud": {
                "orderId": order_id,
                "orderType": order_type,
                "accountId": account_id,
                "accountType": account_type,
                "provider": "LEXISNEXIS",
                "riskBand": "LOW" if bucket < 90 else "HIGH",
            },
        },
    )
    if not (is_in_progress and bucket < 70):
        emit(
            "domain.fraud.events",
            {
                "eventId": f"L50K-FRD-E-{idx}",
                "eventTime": iso_z(t_fraud_e),
                "eventType": "FRAUD_CHECK_APPROVED",
                "fraud": {
                    "orderId": order_id,
                    "orderType": order_type,
                    "accountId": account_id,
                    "accountType": account_type,
                    "provider": "LEXISNEXIS",
                    "riskBand": "LOW",
                },
            },
        )

    # 3. Payment Auth (Root Order)
    t_pay_s = t_fraud_e + timedelta(seconds=3)
    t_pay_e = t_pay_s + timedelta(seconds=rng.randint(5, 35))
    emit(
        "domain.payment.events",
        {
            "eventId": f"L50K-PAY-S-{idx}",
            "eventTime": iso_z(t_pay_s),
            "eventType": "PAYMENT_AUTH_STARTED",
            "payment": {
                "orderId": order_id,
                "orderType": order_type,
                "accountId": account_id,
                "accountType": account_type,
                "gateway": "CYBERSOURCE",
                "methodType": "CREDIT_CARD",
                "currency": "USD",
            },
        },
    )

    # 4. Short-lived Change Order (5% = 2,500) -> Cross-Order SLA Pause/Resume
    if has_change_order and chg_id:
        stats["change_orders"] += 1
        t_chg_s = t_pay_s + timedelta(seconds=5)
        t_chg_e = t_chg_s + timedelta(seconds=rng.randint(25, 120))
        emit(
            "domain.order.events",
            {
                "eventId": f"L50K-CHG-S-{idx}",
                "eventTime": iso_z(t_chg_s),
                "eventType": "CHANGE_ORDER_CREATED",
                "sourceSystem": "OMS-LOAD50K",
                "order": {
                    "orderId": chg_id,
                    "parentOrderId": order_id,
                    "orderType": "SUPP_PAYMENT_UPDATE",
                    "status": "IN_PROGRESS",
                    "channel": channel,
                    "customer": {"accountId": account_id, "accountType": account_type},
                },
            },
        )
        emit(
            "domain.order.events",
            {
                "eventId": f"L50K-CHG-E-{idx}",
                "eventTime": iso_z(t_chg_e),
                "eventType": "CHANGE_ORDER_COMPLETED",
                "sourceSystem": "OMS-LOAD50K",
                "order": {
                    "orderId": chg_id,
                    "parentOrderId": order_id,
                    "orderType": "SUPP_PAYMENT_UPDATE",
                    "status": "COMPLETED",
                    "channel": channel,
                    "customer": {"accountId": account_id, "accountType": account_type},
                },
            },
        )

    if is_domain_fail and bucket == 97:
        emit(
            "domain.payment.events",
            {
                "eventId": f"L50K-PAY-F-{idx}",
                "eventTime": iso_z(t_pay_e),
                "eventType": "PAYMENT_AUTH_DECLINED",
                "payment": {
                    "orderId": order_id,
                    "orderType": order_type,
                    "accountId": account_id,
                    "accountType": account_type,
                    "gateway": "CYBERSOURCE",
                    "declineCode": "PAY_INSUFFICIENT_FUNDS",
                },
            },
        )
    elif not (is_in_progress and bucket < 75):
        emit(
            "domain.payment.events",
            {
                "eventId": f"L50K-PAY-E-{idx}",
                "eventTime": iso_z(t_pay_e),
                "eventType": "PAYMENT_AUTH_CAPTURED",
                "payment": {
                    "orderId": order_id,
                    "orderType": order_type,
                    "accountId": account_id,
                    "accountType": account_type,
                    "gateway": "CYBERSOURCE",
                    "methodType": "CREDIT_CARD",
                },
            },
        )

    # 5. Item-Level Fulfillment / Port-In FOC / eSIM Activation (triggers ONNX models live!)
    t_item_s = t_pay_e + timedelta(seconds=10)
    if is_port_in:
        # Exercises port_foc_duration_aft_v1.onnx!
        foc_dur_s = rng.randint(foc_min_s, foc_max_s)
        t_foc_e = t_item_s + timedelta(seconds=foc_dur_s)
        emit(
            "domain.provisioning.events",
            {
                "eventId": f"L50K-PORT-S-{idx}",
                "eventTime": iso_z(t_item_s),
                "eventType": "PORT_REQUEST_SUBMITTED",
                "provisioning": {
                    "orderId": order_id,
                    "lineItemId": "ITM-1",
                    "orderType": order_type,
                    "accountId": account_id,
                    "accountType": account_type,
                    "portIn": {"donorCarrier": donor_carrier, "portType": port_type},
                },
            },
        )
        if is_completed:
            emit(
                "domain.provisioning.events",
                {
                    "eventId": f"L50K-PORT-E-{idx}",
                    "eventTime": iso_z(t_foc_e),
                    "eventType": "PORT_FOC_RECEIVED",
                    "provisioning": {
                        "orderId": order_id,
                        "lineItemId": "ITM-1",
                        "orderType": order_type,
                        "accountId": account_id,
                        "accountType": account_type,
                        "portIn": {"donorCarrier": donor_carrier, "portType": port_type},
                    },
                },
            )
            emit(
                "domain.provisioning.events",
                {
                    "eventId": f"L50K-ESIM-S-{idx}",
                    "eventTime": iso_z(t_foc_e + timedelta(seconds=5)),
                    "eventType": "ESIM_DOWNLOAD_STARTED",
                    "provisioning": {
                        "orderId": order_id,
                        "lineItemId": "ITM-1",
                        "orderType": order_type,
                        "accountId": account_id,
                        "accountType": account_type,
                        "esim": {"smDpVendor": "THALES"},
                    },
                },
            )
            emit(
                "domain.provisioning.events",
                {
                    "eventId": f"L50K-ESIM-E-{idx}",
                    "eventTime": iso_z(t_foc_e + timedelta(seconds=rng.randint(30, 240))),
                    "eventType": "ESIM_ACTIVATED",
                    "provisioning": {
                        "orderId": order_id,
                        "lineItemId": "ITM-1",
                        "orderType": order_type,
                        "accountId": account_id,
                        "accountType": account_type,
                        "esim": {"smDpVendor": "THALES"},
                    },
                },
            )
        elif is_domain_fail and bucket == 98:
            emit(
                "domain.provisioning.events",
                {
                    "eventId": f"L50K-PORT-F-{idx}",
                    "eventTime": iso_z(t_item_s + timedelta(seconds=60)),
                    "eventType": "PORT_REQUEST_REJECTED",
                    "provisioning": {
                        "orderId": order_id,
                        "lineItemId": "ITM-1",
                        "orderType": order_type,
                        "accountId": account_id,
                        "accountType": account_type,
                        "errorCode": "PORT_ACCOUNT_PIN_INVALID",
                        "portIn": {"donorCarrier": donor_carrier, "portType": port_type},
                    },
                },
            )
    else:
        # SALES_UPGRADE -> Exercises fulfillment_ship_xgb_aft_v1.onnx + esim_activation_lgbm_v1.onnx!
        ship_dur_s = rng.randint(1800, 144000) if fulfillment_method == "SHIP_TO_HOME" else rng.randint(600, 28800)
        t_ship_e = t_item_s + timedelta(seconds=ship_dur_s)
        emit(
            "domain.fulfillment.events",
            {
                "eventId": f"L50K-SHP-S-{idx}",
                "eventTime": iso_z(t_item_s),
                "eventType": "WAREHOUSE_PICK_STARTED",
                "fulfillment": {
                    "orderId": order_id,
                    "lineItemId": "ITM-1",
                    "orderType": order_type,
                    "accountId": account_id,
                    "accountType": account_type,
                    "carrier": "UPS",
                    "warehouseId": f"WH-{(idx % 8) + 1:02d}",
                },
            },
        )
        if is_completed:
            emit(
                "domain.fulfillment.events",
                {
                    "eventId": f"L50K-SHP-E-{idx}",
                    "eventTime": iso_z(t_ship_e),
                    "eventType": "SHIPMENT_DELIVERED",
                    "fulfillment": {
                        "orderId": order_id,
                        "lineItemId": "ITM-1",
                        "orderType": order_type,
                        "accountId": account_id,
                        "accountType": account_type,
                        "carrier": "UPS",
                        "warehouseId": f"WH-{(idx % 8) + 1:02d}",
                    },
                },
            )
            t_esim_s = t_ship_e + timedelta(seconds=30)
            t_esim_e = t_esim_s + timedelta(seconds=rng.randint(20, 300))
            emit(
                "domain.provisioning.events",
                {
                    "eventId": f"L50K-ESIM-S-{idx}",
                    "eventTime": iso_z(t_esim_s),
                    "eventType": "ESIM_DOWNLOAD_STARTED",
                    "provisioning": {
                        "orderId": order_id,
                        "lineItemId": "ITM-1",
                        "orderType": order_type,
                        "accountId": account_id,
                        "accountType": account_type,
                        "esim": {"smDpVendor": "IDEMIA"},
                    },
                },
            )
            emit(
                "domain.provisioning.events",
                {
                    "eventId": f"L50K-ESIM-E-{idx}",
                    "eventTime": iso_z(t_esim_e),
                    "eventType": "ESIM_ACTIVATED",
                    "provisioning": {
                        "orderId": order_id,
                        "lineItemId": "ITM-1",
                        "orderType": order_type,
                        "accountId": account_id,
                        "accountType": account_type,
                        "esim": {"smDpVendor": "IDEMIA"},
                    },
                },
            )
        elif is_domain_fail and bucket == 99:
            emit(
                "domain.fulfillment.events",
                {
                    "eventId": f"L50K-SHP-F-{idx}",
                    "eventTime": iso_z(t_item_s + timedelta(seconds=300)),
                    "eventType": "SHIPMENT_EXCEPTION",
                    "fulfillment": {
                        "orderId": order_id,
                        "lineItemId": "ITM-1",
                        "orderType": order_type,
                        "accountId": account_id,
                        "accountType": account_type,
                        "carrier": "UPS",
                        "exceptionCode": "WMS_INVENTORY_SHORTAGE",
                    },
                },
            )

    # 6. Companion Orders Progress (Trade-In exercises trade_in_return_aft_v1.onnx; Insurance completes)
    if has_trade_in and tradein_id:
        t_trd_s = t_item_s + timedelta(seconds=120)
        emit(
            "domain.fulfillment.events",
            {
                "eventId": f"L50K-TRD-KIT-{idx}",
                "eventTime": iso_z(t_trd_s),
                "eventType": "TRADEIN_KIT_SHIPPED",
                "fulfillment": {
                    "tradeInOrderId": tradein_id,
                    "orderType": "DEVICE_TRADE_IN",
                    "accountId": account_id,
                    "accountType": account_type,
                    "carrier": "UPS",
                },
            },
        )
        if is_completed:
            t_trd_rcv = t_trd_s + timedelta(seconds=rng.randint(86400, 10 * 86400))
            emit(
                "domain.fulfillment.events",
                {
                    "eventId": f"L50K-TRD-RCV-{idx}",
                    "eventTime": iso_z(t_trd_rcv),
                    "eventType": "TRADEIN_DEVICE_RECEIVED",
                    "fulfillment": {
                        "tradeInOrderId": tradein_id,
                        "orderType": "DEVICE_TRADE_IN",
                        "accountId": account_id,
                        "accountType": account_type,
                        "carrier": "UPS",
                    },
                },
            )

    if has_insurance and promo_id and is_completed:
        emit(
            "domain.provisioning.events",
            {
                "eventId": f"L50K-PROMO-E-{idx}",
                "eventTime": iso_z(t_item_s + timedelta(seconds=90)),
                "eventType": "PARTNER_PROMO_ENROLLED",
                "provisioning": {
                    "promoOrderId": promo_id,
                    "orderType": "INTERNAL_PROMO_PROVISIONING",
                    "accountId": account_id,
                    "accountType": account_type,
                    "partner": {"partnerName": "ASSURANT"},
                },
            },
        )

    # 7. Root Order Completion (65% completed)
    if is_completed:
        t_done = t_item_s + timedelta(seconds=rng.randint(600, 7200))
        emit(
            "domain.order.events",
            {
                "eventId": f"L50K-ORD-DONE-{idx}",
                "eventTime": iso_z(t_done),
                "eventType": "ORDER_COMPLETED",
                "sourceSystem": "OMS-LOAD50K",
                "order": {
                    "orderId": order_id,
                    "orderType": order_type,
                    "status": "COMPLETED",
                    "channel": channel,
                    "customer": {"accountId": account_id, "accountType": account_type},
                    "lineItems": [
                        {
                            "lineItemId": "ITM-1",
                            "itemType": primary_item_type,
                            "status": "COMPLETED",
                        }
                    ],
                },
            },
        )

    # 8. Fallout Management BPMN + Repeat Boomerang Fallouts (7% = 3,500 orders)
    if is_fallout:
        err_code, failed_tmpl, failed_act, queue = FALLOUT_ERRORS[idx % len(FALLOUT_ERRORS)]
        flt_id_1 = f"L50K-FLT-{idx:06d}-1"
        t_flt_open = t_item_s + timedelta(seconds=15)
        stats["fallouts"] += 1

        emit(
            "flowable.fallout.events",
            {
                "eventId": f"L50K-FLT-O1-{idx}",
                "eventTime": iso_z(t_flt_open),
                "eventType": "FALLOUT_OPENED",
                "processInstanceId": f"L50K-PROC-{flt_id_1}",
                "processDefinitionKey": "falloutManagementBpmn",
                "variables": {
                    "falloutId": flt_id_1,
                    "failedOrderId": order_id,
                    "failedOrderItemId": "ITM-1",
                    "failedTemplateId": failed_tmpl,
                    "failedActivityId": failed_act,
                    "errorCode": err_code,
                    "assignedQueue": queue,
                    "accountId": account_id,
                    "accountType": account_type,
                },
            },
        )

        # bucket 90..93 -> OPEN/IN_QUEUE (2,000); 94..95 -> RESOLVED (1,000); 96 -> REPEAT BOOMERANG (500)!
        if bucket in (94, 95, 96):
            t_flt_res = t_flt_open + timedelta(seconds=rng.randint(120, 1800))
            emit(
                "flowable.fallout.events",
                {
                    "eventId": f"L50K-FLT-R1-{idx}",
                    "eventTime": iso_z(t_flt_res),
                    "eventType": "FALLOUT_RESOLVED",
                    "processInstanceId": f"L50K-PROC-{flt_id_1}",
                    "processDefinitionKey": "falloutManagementBpmn",
                    "variables": {
                        "falloutId": flt_id_1,
                        "failedOrderId": order_id,
                        "failedOrderItemId": "ITM-1",
                        "failedTemplateId": failed_tmpl,
                        "failedActivityId": failed_act,
                        "errorCode": err_code,
                        "assignedQueue": queue,
                        "resolutionAction": "RETRY_ACTIVITY",
                        "accountId": account_id,
                        "accountType": account_type,
                    },
                },
            )
            if bucket == 96:
                # Boomerang Repeat Fallout #2 (new BPMN instance matching same milestone + errorCode!)
                flt_id_2 = f"L50K-FLT-{idx:06d}-2"
                stats["fallouts"] += 1
                stats["boomerangs"] += 1
                emit(
                    "flowable.fallout.events",
                    {
                        "eventId": f"L50K-FLT-O2-{idx}",
                        "eventTime": iso_z(t_flt_res + timedelta(seconds=45)),
                        "eventType": "FALLOUT_OPENED",
                        "processInstanceId": f"L50K-PROC-{flt_id_2}",
                        "processDefinitionKey": "falloutManagementBpmn",
                        "variables": {
                            "falloutId": flt_id_2,
                            "failedOrderId": order_id,
                            "failedOrderItemId": "ITM-1",
                            "failedTemplateId": failed_tmpl,
                            "failedActivityId": failed_act,
                            "errorCode": err_code,
                            "assignedQueue": queue,
                            "accountId": account_id,
                            "accountType": account_type,
                        },
                    },
                )

    # 9. Flowable BPMN Noise (dropped O(1) in Stage 1 before Stage 2/3)
    for n in range(noise_per_order):
        evt_type, act_type, act_id = NOISE_TYPES[(idx + n) % len(NOISE_TYPES)]
        emit(
            "flowable.activity.events",
            {
                "eventId": f"L50K-NOISE-{idx}-{n}",
                "eventTime": iso_z(t0 + timedelta(seconds=n + 1)),
                "eventType": evt_type,
                "processInstanceId": f"L50K-PROC-ORD-{idx}",
                "processDefinitionKey": "salesOrderBpmn",
                "activityId": act_id,
                "activityType": act_type,
                "variables": {"loopCounter": n},
            },
        )
        stats["noise"] += 1

    return records, stats


def main() -> int:
    parser = argparse.ArgumentParser(description="50,000-order production load simulator")
    parser.add_argument("--bootstrap-servers", default="localhost:29092")
    parser.add_argument("--orders", type=int, default=50000)
    parser.add_argument("--start-index", type=int, default=1)
    parser.add_argument("--batch-orders", type=int, default=1000)
    parser.add_argument("--noise-per-order", type=int, default=1)
    parser.add_argument("--poison-pills", type=int, default=100)
    parser.add_argument("--batch-sleep-ms", type=int, default=50)
    parser.add_argument("--seed", type=int, default=20261127)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    base_now = datetime.now(timezone.utc)

    producer = KafkaProducer(
        bootstrap_servers=args.bootstrap_servers,
        acks=1,
        linger_ms=25,
        batch_size=65536,
        buffer_memory=67108864,
        compression_type="gzip",
        request_timeout_ms=30000,
        retries=5,
    )

    totals = {
        "root_orders": 0,
        "order_items": 0,
        "trade_ins": 0,
        "insurances": 0,
        "change_orders": 0,
        "fallouts": 0,
        "boomerangs": 0,
        "noise": 0,
        "poison_pills": 0,
        "kafka_messages": 0,
    }

    t_start = time.monotonic()
    print(
        f"Starting {args.orders:,}-order unpartitioned Kafka load test -> {args.bootstrap_servers} "
        f"(batch={args.batch_orders}, noise/order={args.noise_per_order}, poison={args.poison_pills})",
        flush=True,
    )

    # Inject poison pills periodically across the run to verify DLQ isolation without crashing Flink
    poison_interval = max(1, args.orders // max(1, args.poison_pills))

    end_index = args.start_index + args.orders - 1
    for seq, i in enumerate(range(args.start_index, end_index + 1), start=1):
        recs, st = build_order_records(i, rng, base_now, args.noise_per_order)
        for topic, payload_bytes in recs:
            # Deliberately key=None (unpartitioned) to match AWS MSK default round-robin partitioning!
            producer.send(topic, key=None, value=payload_bytes)
            totals["kafka_messages"] += 1

        for k, v in st.items():
            totals[k] += v

        if args.poison_pills > 0 and seq % poison_interval == 0 and totals["poison_pills"] < args.poison_pills:
            bad_bytes = f"{{MALFORMED-JSON-LOAD50K-{i}".encode("utf-8")
            producer.send("domain.order.events", key=None, value=bad_bytes)
            totals["poison_pills"] += 1
            totals["kafka_messages"] += 1

        if seq % args.batch_orders == 0 or seq == args.orders:
            producer.flush()
            elapsed = max(0.001, time.monotonic() - t_start)
            if seq % 5000 == 0 or seq == args.orders:
                print(
                    f"  [{seq:6d}/{args.orders}] elapsed={elapsed:6.1f}s "
                    f"rate={seq/elapsed:6.0f} ord/s | msgs={totals['kafka_messages']:,} ({totals['kafka_messages']/elapsed:,.0f} msg/s)",
                    flush=True,
                )
            if args.batch_sleep_ms > 0 and seq < args.orders:
                time.sleep(args.batch_sleep_ms / 1000.0)

    producer.flush()
    producer.close()
    elapsed = max(0.001, time.monotonic() - t_start)

    expected_entities = (
        totals["root_orders"]
        + totals["order_items"]
        + totals["trade_ins"]
        + totals["insurances"]
        + totals["change_orders"]
    )
    print("\n=== PRODUCER SUMMARY ===")
    print(json.dumps({**totals, "expected_tracked_entities": expected_entities, "elapsed_sec": round(elapsed, 2)}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
