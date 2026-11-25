#!/usr/bin/env python3
"""
50 Telecom Order Item Types Catalog for Order Types `SALES` (25) and `CHANGE` (25).

Shared single source of truth used by:
  1. `config/blueprints/sales-and-change-50-items.yaml` (generated via `--write-blueprints`)
  2. `tools/event-simulator/simulate.py --scenario scale-50-items` (high-volume E2E load)

Zero hardcoding in Java: Flink & Spring Boot learn all 50 item types exclusively via
Admin Config Studio YAML seeding + Kafka `jeopardy.config.updates` hot-reload.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Tuple


@dataclass(frozen=True)
class ItemTypeSpec:
    order_type: str        # "SALES" or "CHANGE"
    item_type: str         # e.g. "CHANGE_ESIM", "CHANGE_PLAN", "SALES_HANDSET_SHIP"
    display_name: str
    order_family: str      # WIRELESS_NEW | UPGRADES_TRADEIN | PORT_INS | PLAN_PROMO | CHANGE_CANCEL | BROADBAND
    archetype: str         # DEVICE_SHIP | PORT_IN | DIGITAL_ESIM | PLAN_BILLING | PARTNER_PERK | TRADE_IN | PAYMENT_AMEND | ACCOUNT_LIFECYCLE
    default_error_code: str
    fallout_queue: str
    overall_warning: str
    overall_jeopardy: str
    overall_breach: str
    state_ttl_days: int = 30


# =============================================================================
# 25 SALES Order Item Types + 25 CHANGE Order Item Types = 50 Item Types Total
# =============================================================================
CATALOG_50_ITEMS: Tuple[ItemTypeSpec, ...] = (
    # ---------------- 25 SALES ITEM TYPES ----------------
    ItemTypeSpec("SALES", "SALES_HANDSET_SHIP", "Handset Ship-to-Home Fulfillment", "WIRELESS_NEW", "DEVICE_SHIP", "E_INVENTORY_BACKORDER", "FULFILLMENT_WAREHOUSE_OPS", "48h", "72h", "120h", 30),
    ItemTypeSpec("SALES", "SALES_HANDSET_BOPIS", "Handset Buy-Online Pick-Up In-Store", "WIRELESS_NEW", "DEVICE_SHIP", "E_STORE_PICK_TIMEOUT", "RETAIL_BOPIS_OPS", "4h", "8h", "24h", 14),
    ItemTypeSpec("SALES", "SALES_HANDSET_UPGRADE", "Device Upgrade Ship-to-Home", "UPGRADES_TRADEIN", "DEVICE_SHIP", "E_IMEI_RESERVE_FAILED", "FULFILLMENT_WAREHOUSE_OPS", "48h", "72h", "120h", 30),
    ItemTypeSpec("SALES", "SALES_EARLY_UPGRADE_JUMP", "Early Upgrade Lease Buyout & Ship", "UPGRADES_TRADEIN", "DEVICE_SHIP", "E_LEASE_BUYOUT_REJECTED", "UPGRADE_FINANCE_OPS", "48h", "72h", "120h", 30),
    ItemTypeSpec("SALES", "SALES_BYOD_ESIM", "BYOD Instant eSIM Activation", "WIRELESS_NEW", "DIGITAL_ESIM", "E_ESIM_PROFILE_LOCKED", "ESIM_NETWORK_OPS_L2", "10m", "20m", "2h", 14),
    ItemTypeSpec("SALES", "SALES_BYOD_PSIM", "BYOD Physical SIM Kit Ship & Activate", "WIRELESS_NEW", "DEVICE_SHIP", "E_SIM_ICCID_MISMATCH", "SIM_FULFILLMENT_OPS", "48h", "72h", "96h", 21),
    ItemTypeSpec("SALES", "SALES_PORT_IN_WIRELESS", "Wireless Number Port-In & eSIM Cutover", "PORT_INS", "PORT_IN", "E_PORT_PIN_INVALID", "LNP_PORTING_OPS_L2", "30m", "2h", "48h", 30),
    ItemTypeSpec("SALES", "SALES_PORT_IN_WIRELINE", "Wireline / VoIP Port-In Cutover", "PORT_INS", "PORT_IN", "E_PORT_CSR_MISMATCH", "LNP_WIRELINE_OPS", "24h", "48h", "72h", 30),
    ItemTypeSpec("SALES", "SALES_PORT_IN_ENTERPRISE", "Enterprise Bulk Number Port-In", "PORT_INS", "PORT_IN", "E_PORT_LOA_MISSING", "ENTERPRISE_LNP_OPS", "4h", "12h", "72h", 30),
    ItemTypeSpec("SALES", "SALES_ADD_LINE_VOICE", "Add-a-Line Voice Subscriber Activation", "WIRELESS_NEW", "DIGITAL_ESIM", "E_HLR_SUBSCRIBER_CONFLICT", "CORE_NETWORK_OPS", "15m", "30m", "2h", 14),
    ItemTypeSpec("SALES", "SALES_ADD_LINE_WEARABLE", "Smartwatch eSIM Companion Line Add", "WIRELESS_NEW", "DIGITAL_ESIM", "E_EID_PAIRING_FAILED", "ESIM_NETWORK_OPS_L2", "15m", "30m", "2h", 14),
    ItemTypeSpec("SALES", "SALES_ADD_LINE_TABLET", "5G Connected Tablet Line & Ship", "WIRELESS_NEW", "DEVICE_SHIP", "E_DATA_SOC_PROVISION_ERR", "FULFILLMENT_WAREHOUSE_OPS", "48h", "72h", "120h", 30),
    ItemTypeSpec("SALES", "SALES_ADD_LINE_IOT", "IoT / Connected Car Telemetry Line", "WIRELESS_NEW", "DIGITAL_ESIM", "E_APN_PROFILE_REJECTED", "IOT_PROVISIONING_OPS", "15m", "45m", "4h", 14),
    ItemTypeSpec("SALES", "SALES_5G_HOME_GATEWAY", "5G Home Internet Gateway Ship & Activate", "BROADBAND", "DEVICE_SHIP", "E_FWA_SECTOR_CAPACITY", "BROADBAND_FWA_OPS", "48h", "72h", "120h", 30),
    ItemTypeSpec("SALES", "SALES_FIBER_ONT_INSTALL", "Fiber Broadband ONT Dispatch & Provision", "BROADBAND", "DEVICE_SHIP", "E_ONT_LIGHT_LEVEL_FAIL", "FIBER_DISPATCH_OPS", "72h", "120h", "168h", 45),
    ItemTypeSpec("SALES", "SALES_HOTSPOT_DEVICE", "5G Mobile Hotspot Device & Data Line", "BROADBAND", "DEVICE_SHIP", "E_HOTSPOT_IMEI_INVALID", "FULFILLMENT_WAREHOUSE_OPS", "48h", "72h", "120h", 30),
    ItemTypeSpec("SALES", "SALES_ACCESSORY_SHIP", "Accessory Ship-to-Home Fulfillment", "UPGRADES_TRADEIN", "DEVICE_SHIP", "E_ACCESSORY_SKU_OOS", "FULFILLMENT_WAREHOUSE_OPS", "48h", "72h", "120h", 21),
    ItemTypeSpec("SALES", "SALES_ACCESSORY_BOPIS", "Accessory In-Store Pickup", "UPGRADES_TRADEIN", "DEVICE_SHIP", "E_STORE_INVENTORY_SHORT", "RETAIL_BOPIS_OPS", "4h", "8h", "24h", 14),
    ItemTypeSpec("SALES", "SALES_TRADE_IN_MAILIN", "60-Day Mail-In Trade-In Kit & Credit", "UPGRADES_TRADEIN", "TRADE_IN", "E_TRADEIN_FMD_LOCKED", "TRADEIN_INSPECTION_OPS", "21d", "30d", "60d", 65),
    ItemTypeSpec("SALES", "SALES_TRADE_IN_INSTORE", "In-Store Instant Trade-In Inspection", "UPGRADES_TRADEIN", "TRADE_IN", "E_TRADEIN_IMEI_BLACKLIST", "TRADEIN_INSPECTION_OPS", "2h", "6h", "24h", 30),
    ItemTypeSpec("SALES", "SALES_DEVICE_INSURANCE", "Device Protection / Insurance Enrollment", "PLAN_PROMO", "PARTNER_PERK", "E_PARTNER_ASSURANT_503", "PARTNER_ENROLLMENT_OPS", "20m", "45m", "2h", 14),
    ItemTypeSpec("SALES", "SALES_STREAMING_PERK", "Partner Streaming Bundle Enrollment", "PLAN_PROMO", "PARTNER_PERK", "E_PARTNER_TOKEN_EXPIRED", "PARTNER_ENROLLMENT_OPS", "15m", "30m", "2h", 14),
    ItemTypeSpec("SALES", "SALES_INTERNATIONAL_PASS", "International Roaming Data Pass Sale", "PLAN_PROMO", "PLAN_BILLING", "E_ROAMING_SOC_CONFLICT", "BILLING_SOC_OPS", "10m", "25m", "1h", 14),
    ItemTypeSpec("SALES", "SALES_PREPAID_TO_POSTPAID", "Prepaid-to-Postpaid Account Migration", "WIRELESS_NEW", "DIGITAL_ESIM", "E_BAN_MIGRATION_LOCKED", "MIGRATION_BILLING_OPS", "30m", "1h", "4h", 21),
    ItemTypeSpec("SALES", "SALES_BUSINESS_FLEET_LINE", "Enterprise Fleet Bulk Handset & Line", "WIRELESS_NEW", "DEVICE_SHIP", "E_FLEET_CREDIT_LIMIT", "ENTERPRISE_ORDER_OPS", "48h", "72h", "120h", 30),

    # ---------------- 25 CHANGE ITEM TYPES ----------------
    ItemTypeSpec("CHANGE", "CHANGE_ESIM", "eSIM Swap / Re-Download Profile Change", "CHANGE_CANCEL", "DIGITAL_ESIM", "E_ESIM_EID_LOCKED", "ESIM_NETWORK_OPS_L2", "8m", "15m", "2h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_PLAN", "Rate Plan Tier Change & Billing Sync", "PLAN_PROMO", "PLAN_BILLING", "E_BILLING_SOC_CONFLICT", "BILLING_SOC_OPS", "10m", "25m", "2h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_PSIM_SWAP", "Physical SIM Card Replacement Swap", "CHANGE_CANCEL", "DIGITAL_ESIM", "E_SIM_ICCID_ALREADY_USED", "SIM_PROVISIONING_OPS", "10m", "25m", "2h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_MSISDN", "Mobile Number (MDN) Change Request", "CHANGE_CANCEL", "DIGITAL_ESIM", "E_MDN_POOL_EXHAUSTED", "CORE_NETWORK_OPS", "15m", "30m", "2h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_PAYMENT_METHOD", "Supplemental Payment Card Update", "CHANGE_CANCEL", "PAYMENT_AMEND", "E_PAYMENT_AVS_MISMATCH", "PAYMENT_GATEWAY_OPS", "10m", "20m", "30m", 7),
    ItemTypeSpec("CHANGE", "CHANGE_SHIPPING_ADDRESS", "In-Flight Shipping Address Amendment", "CHANGE_CANCEL", "PAYMENT_AMEND", "E_CARRIER_INTERCEPT_DENIED", "FULFILLMENT_AMEND_OPS", "15m", "30m", "2h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_BILLING_CYCLE", "Account Bill Cycle Date Change", "CHANGE_CANCEL", "PLAN_BILLING", "E_BILL_CYCLE_IN_RUN", "BILLING_SOC_OPS", "15m", "30m", "4h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_ADD_FEATURE", "Add Line Feature / Bolt-On SOC", "PLAN_PROMO", "PLAN_BILLING", "E_FEATURE_INCOMPATIBLE", "BILLING_SOC_OPS", "10m", "20m", "2h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_REMOVE_FEATURE", "Remove Line Feature / Bolt-On SOC", "PLAN_PROMO", "PLAN_BILLING", "E_FEATURE_DEP_ACTIVE", "BILLING_SOC_OPS", "10m", "20m", "2h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_SUSPEND_VOLUNTARY", "Voluntary Seasonal Line Suspend", "CHANGE_CANCEL", "ACCOUNT_LIFECYCLE", "E_NETWORK_BARRING_TIMEOUT", "CARE_LIFECYCLE_OPS", "10m", "20m", "2h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_SUSPEND_LOST_STOLEN", "Lost / Stolen IMEI Block & Suspend", "CHANGE_CANCEL", "ACCOUNT_LIFECYCLE", "E_EIR_BLACKLIST_SYNC_ERR", "FRAUD_SECURITY_OPS", "5m", "10m", "30m", 14),
    ItemTypeSpec("CHANGE", "CHANGE_RESUME_LINE", "Resume Suspended Wireless Line", "CHANGE_CANCEL", "ACCOUNT_LIFECYCLE", "E_HLR_UNBAR_REJECTED", "CORE_NETWORK_OPS", "10m", "20m", "2h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_CANCEL_LINE", "Disconnect / Cancel Wireless Line", "CHANGE_CANCEL", "ACCOUNT_LIFECYCLE", "E_EIP_ACCELERATION_FAIL", "CARE_RETENTION_OPS", "15m", "30m", "4h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_CANCEL_ORDER", "In-Flight Order Cancellation Request", "CHANGE_CANCEL", "ACCOUNT_LIFECYCLE", "E_WAREHOUSE_ALREADY_SHIPPED", "FULFILLMENT_AMEND_OPS", "10m", "20m", "1h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_RESPONSIBILITY_COR", "Change of Responsibility (Account Transfer)", "CHANGE_CANCEL", "ACCOUNT_LIFECYCLE", "E_COR_CREDIT_DECLINED", "CARE_TRANSFER_OPS", "30m", "1h", "6h", 21),
    ItemTypeSpec("CHANGE", "CHANGE_PORT_OUT_PIN", "Number Transfer PIN Generation / Lock", "PORT_INS", "ACCOUNT_LIFECYCLE", "E_PIN_LOCK_CONFLICT", "LNP_PORTING_OPS_L2", "5m", "15m", "1h", 7),
    ItemTypeSpec("CHANGE", "CHANGE_CALLER_ID_NAME", "CNAM Outbound Caller ID Name Update", "CHANGE_CANCEL", "PLAN_BILLING", "E_CNAM_REGISTRY_504", "CORE_NETWORK_OPS", "15m", "30m", "4h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_ROAMING_ENABLE", "Enable International Roaming Profile", "PLAN_PROMO", "DIGITAL_ESIM", "E_ROAMING_HSS_REJECT", "CORE_NETWORK_OPS", "10m", "20m", "2h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_ROAMING_DISABLE", "Disable International Roaming Profile", "PLAN_PROMO", "DIGITAL_ESIM", "E_ROAMING_HSS_TIMEOUT", "CORE_NETWORK_OPS", "10m", "20m", "2h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_VOICEMAIL_RESET", "Visual Voicemail Provisioning Reset", "CHANGE_CANCEL", "DIGITAL_ESIM", "E_VVM_MAILBOX_LOCKED", "CORE_NETWORK_OPS", "10m", "20m", "1h", 7),
    ItemTypeSpec("CHANGE", "CHANGE_INSURANCE_ADD", "Post-Sales Device Insurance Add", "PLAN_PROMO", "PARTNER_PERK", "E_PARTNER_ELIGIBILITY_ERR", "PARTNER_ENROLLMENT_OPS", "15m", "30m", "2h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_INSURANCE_REMOVE", "Cancel Device Protection Plan", "PLAN_PROMO", "PARTNER_PERK", "E_PARTNER_CANCEL_502", "PARTNER_ENROLLMENT_OPS", "15m", "30m", "2h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_PERK_SWAP", "Swap Partner Streaming / Cloud Perk", "PLAN_PROMO", "PARTNER_PERK", "E_PARTNER_ENTITLEMENT_ERR", "PARTNER_ENROLLMENT_OPS", "15m", "30m", "2h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_DISCOUNT_PROMO", "Apply Military / Employee / Loyalty Discount", "PLAN_PROMO", "PLAN_BILLING", "E_PROMO_ELIGIBILITY_FAIL", "BILLING_SOC_OPS", "15m", "30m", "4h", 14),
    ItemTypeSpec("CHANGE", "CHANGE_AUTOPAY_ENROLL", "AutoPay & Paperless Billing Enrollment", "CHANGE_CANCEL", "PLAN_BILLING", "E_AUTOPAY_TOKEN_INVALID", "PAYMENT_GATEWAY_OPS", "10m", "20m", "2h", 14),
)

assert len(CATALOG_50_ITEMS) == 50, f"Expected 50 item types, got {len(CATALOG_50_ITEMS)}"
assert sum(1 for x in CATALOG_50_ITEMS if x.order_type == "SALES") == 25
assert sum(1 for x in CATALOG_50_ITEMS if x.order_type == "CHANGE") == 25


def steps_for_archetype(spec: ItemTypeSpec) -> List[Dict[str, Any]]:
    """Compose reusable Block-2 Milestone Templates with item-specific displayNames & SLAs."""
    a = spec.archetype
    name = spec.display_name
    if a == "DEVICE_SHIP":
        return [
            {"stepId": "S1", "useTemplate": "TMPL_ORDER_RECEIVED", "displayName": f"{name} Submitted", "dependsOn": []},
            {"stepId": "S2", "useTemplate": "TMPL_FRAUD_CHECK", "displayName": "Identity & Fraud Check", "dependsOn": ["S1"]},
            {"stepId": "S3", "useTemplate": "TMPL_PAYMENT_AUTH", "displayName": "Tax & Payment Capture", "dependsOn": ["S2"]},
            {
                "stepId": "S4",
                "useTemplate": "TMPL_FULFILLMENT_SHIP",
                "displayName": f"{name} Warehouse & Delivery",
                "dependsOn": ["S3"],
                "slaOverride": {
                    "mode": "ML_PREDICTED",
                    "modelId": "fulfillment_ship_xgb_aft_v1.onnx",
                    "fallbackExpected": "48h",
                    "warningPct": 80,
                    "jeopardyPct": 95,
                    "hardMin": "4h",
                    "hardMax": "7d",
                },
            },
            {
                "stepId": "S5",
                "useTemplate": "TMPL_ESIM_ACTIVATION",
                "displayName": "Network / eSIM Activation",
                "dependsOn": ["S4"],
                "slaOverride": {
                    "mode": "ML_PREDICTED",
                    "modelId": "esim_activation_lgbm_v1.onnx",
                    "fallbackExpected": "3m",
                    "warning": "10m",
                    "jeopardy": "20m",
                    "hardMin": "10s",
                    "hardMax": "2h",
                },
            },
            {"stepId": "S6", "useTemplate": "TMPL_BILLING_SYNC", "displayName": "Billing & EIP Synchronization", "dependsOn": ["S5"]},
            {"stepId": "S7", "useTemplate": "TMPL_ORDER_CLOSED", "displayName": f"{name} Completed", "dependsOn": ["S6"]},
        ]
    if a == "PORT_IN":
        return [
            {"stepId": "P1", "useTemplate": "TMPL_ORDER_RECEIVED", "displayName": f"{name} Submitted", "dependsOn": []},
            {"stepId": "P2", "useTemplate": "TMPL_FRAUD_CHECK", "displayName": "Port-In Fraud & Account Check", "dependsOn": ["P1"]},
            {
                "stepId": "P3",
                "useTemplate": "TMPL_PORT_FOC",
                "displayName": "Donor Carrier FOC Confirmation",
                "dependsOn": ["P2"],
                "slaOverride": {
                    "mode": "ML_PREDICTED",
                    "modelId": "port_in_foc_xgb_aft_v1.onnx",
                    "fallbackExpected": "15m",
                    "warning": "45m",
                    "jeopardy": "2h",
                    "hardMin": "1m",
                    "hardMax": "72h",
                },
            },
            {
                "stepId": "P4",
                "useTemplate": "TMPL_ESIM_ACTIVATION",
                "displayName": "Number Cutover & eSIM Activation",
                "dependsOn": ["P3"],
                "slaOverride": {
                    "mode": "ML_PREDICTED",
                    "modelId": "esim_activation_lgbm_v1.onnx",
                    "fallbackExpected": "3m",
                    "warning": "10m",
                    "jeopardy": "20m",
                    "hardMin": "10s",
                    "hardMax": "2h",
                },
            },
            {"stepId": "P5", "useTemplate": "TMPL_BILLING_SYNC", "displayName": "Ported Line Billing Sync", "dependsOn": ["P4"]},
            {"stepId": "P6", "useTemplate": "TMPL_ORDER_CLOSED", "displayName": f"{name} Completed", "dependsOn": ["P5"]},
        ]
    if a == "DIGITAL_ESIM":
        return [
            {"stepId": "D1", "useTemplate": "TMPL_ORDER_RECEIVED", "displayName": f"{name} Requested", "dependsOn": []},
            {"stepId": "D2", "useTemplate": "TMPL_FRAUD_CHECK", "displayName": "SIM Swap / Line Security Check", "dependsOn": ["D1"]},
            {
                "stepId": "D3",
                "useTemplate": "TMPL_ESIM_ACTIVATION",
                "displayName": f"{name} Network Provisioning",
                "dependsOn": ["D2"],
                "slaOverride": {
                    "mode": "ML_PREDICTED",
                    "modelId": "esim_activation_lgbm_v1.onnx",
                    "fallbackExpected": "2m",
                    "warning": "8m",
                    "jeopardy": "15m",
                    "hardMin": "10s",
                    "hardMax": "2h",
                },
            },
            {"stepId": "D4", "useTemplate": "TMPL_BILLING_SYNC", "displayName": "Subscriber Profile Billing Sync", "dependsOn": ["D3"]},
            {"stepId": "D5", "useTemplate": "TMPL_ORDER_CLOSED", "displayName": f"{name} Completed", "dependsOn": ["D4"]},
        ]
    if a == "PLAN_BILLING":
        return [
            {"stepId": "B1", "useTemplate": "TMPL_ORDER_RECEIVED", "displayName": f"{name} Requested", "dependsOn": []},
            {"stepId": "B2", "useTemplate": "TMPL_BILLING_SYNC", "displayName": f"{name} SOC & Rating Update", "dependsOn": ["B1"]},
            {"stepId": "B3", "useTemplate": "TMPL_ORDER_CLOSED", "displayName": f"{name} Completed", "dependsOn": ["B2"]},
        ]
    if a == "PARTNER_PERK":
        return [
            {"stepId": "K1", "useTemplate": "TMPL_ORDER_RECEIVED", "displayName": f"{name} Requested", "dependsOn": []},
            {"stepId": "K2", "useTemplate": "TMPL_PARTNER_ENROLL", "displayName": f"{name} Partner API Sync", "dependsOn": ["K1"]},
            {"stepId": "K3", "useTemplate": "TMPL_BILLING_SYNC", "displayName": "Perk / Protection Billing Sync", "dependsOn": ["K2"]},
            {"stepId": "K4", "useTemplate": "TMPL_ORDER_CLOSED", "displayName": f"{name} Completed", "dependsOn": ["K3"]},
        ]
    if a == "TRADE_IN":
        return [
            {"stepId": "T1", "useTemplate": "TMPL_ORDER_RECEIVED", "displayName": f"{name} Quote Locked", "dependsOn": []},
            {
                "stepId": "T2",
                "useTemplate": "TMPL_WAREHOUSE_RCV",
                "displayName": "Return Device Received at Warehouse",
                "dependsOn": ["T1"],
                "slaOverride": {
                    "mode": "ML_PREDICTED",
                    "modelId": "tradein_return_aft_v1.onnx",
                    "fallbackExpected": "14d",
                    "warning": "21d",
                    "jeopardy": "28d",
                    "hardMin": "2d",
                    "hardMax": "35d",
                    "rightCensoredSurvival": True,
                },
            },
            {"stepId": "T3", "useTemplate": "TMPL_INSPECTION", "displayName": "IMEI / FMD Condition Inspection", "dependsOn": ["T2"]},
            {"stepId": "T4", "useTemplate": "TMPL_BILLING_SYNC", "displayName": "Trade-In Bill Credit Applied", "dependsOn": ["T3"]},
            {"stepId": "T5", "useTemplate": "TMPL_ORDER_CLOSED", "displayName": f"{name} Closed", "dependsOn": ["T4"]},
        ]
    if a == "PAYMENT_AMEND":
        return [
            {"stepId": "M1", "useTemplate": "TMPL_ORDER_RECEIVED", "displayName": f"{name} Requested", "dependsOn": []},
            {"stepId": "M2", "useTemplate": "TMPL_PAYMENT_AUTH", "displayName": "Payment Re-Auth / Amendment Validation", "dependsOn": ["M1"]},
            {"stepId": "M3", "useTemplate": "TMPL_ORDER_CLOSED", "displayName": f"{name} Applied", "dependsOn": ["M2"]},
        ]
    # ACCOUNT_LIFECYCLE (suspend, resume, cancel, COR, port-out PIN)
    return [
        {"stepId": "L1", "useTemplate": "TMPL_ORDER_RECEIVED", "displayName": f"{name} Submitted", "dependsOn": []},
        {"stepId": "L2", "useTemplate": "TMPL_FRAUD_CHECK", "displayName": "Account Authority & Fraud Check", "dependsOn": ["L1"]},
        {"stepId": "L3", "useTemplate": "TMPL_ESIM_ACTIVATION", "displayName": "Network Lifecycle State Change", "dependsOn": ["L2"]},
        {"stepId": "L4", "useTemplate": "TMPL_BILLING_SYNC", "displayName": "Billing Account Status Update", "dependsOn": ["L3"]},
        {"stepId": "L5", "useTemplate": "TMPL_ORDER_CLOSED", "displayName": f"{name} Completed", "dependsOn": ["L4"]},
    ]


def build_blueprints_document() -> Dict[str, Any]:
    blueprints: List[Dict[str, Any]] = [
        {
            "blueprintId": "bp-sales-root-order",
            "version": 1,
            "active": True,
            "displayName": "Unified Sales Root Order",
            "orderFamily": "WIRELESS_NEW",
            "orderType": "SALES",
            "itemType": "ROOT_ORDER",
            "entityLevel": "ORDER",
            "stateTtlDays": 30,
            "overallSla": {"warning": "48h", "jeopardy": "72h", "breach": "120h"},
            "steps": [
                {"stepId": "O1", "useTemplate": "TMPL_ORDER_RECEIVED", "displayName": "Sales Order Received", "dependsOn": []},
                {"stepId": "O2", "useTemplate": "TMPL_FRAUD_CHECK", "displayName": "Account Fraud Check", "dependsOn": ["O1"]},
                {"stepId": "O3", "useTemplate": "TMPL_PAYMENT_AUTH", "displayName": "Order Payment Capture", "dependsOn": ["O2"]},
                {"stepId": "O4", "useTemplate": "TMPL_BILLING_SYNC", "displayName": "Account Billing Sync", "dependsOn": ["O3"]},
                {"stepId": "O5", "useTemplate": "TMPL_ORDER_CLOSED", "displayName": "Sales Order Closed", "dependsOn": ["O4"]},
            ],
        },
        {
            "blueprintId": "bp-change-root-order",
            "version": 1,
            "active": True,
            "displayName": "Unified Change Root Order",
            "orderFamily": "CHANGE_CANCEL",
            "orderType": "CHANGE",
            "itemType": "ROOT_ORDER",
            "entityLevel": "ORDER",
            "stateTtlDays": 14,
            "overallSla": {"warning": "15m", "jeopardy": "30m", "breach": "2h"},
            "steps": [
                {"stepId": "C1", "useTemplate": "TMPL_ORDER_RECEIVED", "displayName": "Change Order Received", "dependsOn": []},
                {"stepId": "C2", "useTemplate": "TMPL_BILLING_SYNC", "displayName": "Change Order Billing Sync", "dependsOn": ["C1"]},
                {"stepId": "C3", "useTemplate": "TMPL_ORDER_CLOSED", "displayName": "Change Order Closed", "dependsOn": ["C2"]},
            ],
        },
    ]

    for spec in CATALOG_50_ITEMS:
        bp_id = f"bp-{spec.item_type.lower().replace('_', '-')}"
        blueprints.append(
            {
                "blueprintId": bp_id,
                "version": 1,
                "active": True,
                "displayName": f"{spec.display_name} ({spec.order_type})",
                "orderFamily": spec.order_family,
                "orderType": spec.order_type,
                "itemType": spec.item_type,
                "entityLevel": "ORDER_ITEM",
                "stateTtlDays": spec.state_ttl_days,
                "overallSla": {
                    "warning": spec.overall_warning,
                    "jeopardy": spec.overall_jeopardy,
                    "breach": spec.overall_breach,
                },
                "steps": steps_for_archetype(spec),
            }
        )

    return {
        "schemaVersion": "1.0",
        "configType": "JOURNEY_BLUEPRINT",
        "blueprints": blueprints,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Export 50-item-type SALES & CHANGE blueprints YAML.")
    parser.add_argument(
        "--write-blueprints",
        default="config/blueprints/sales-and-change-50-items.yaml",
        help="Destination YAML file path",
    )
    args = parser.parse_args()
    import yaml  # type: ignore

    doc = build_blueprints_document()
    out_path = Path(args.write_blueprints)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "# =============================================================================\n"
        "# Block 3: 50 Telecom Order Item Types for `SALES` (25) & `CHANGE` (25)\n"
        "# Includes CHANGE_ESIM, CHANGE_PLAN, SALES_HANDSET_SHIP, SALES_PORT_IN_WIRELESS,\n"
        "# etc. Composed strictly from reusable Block-2 Milestone Templates.\n"
        "# Hot-reloaded to Apache Flink via POST /api/v1/admin/configs/seed + /publish\n"
        "# =============================================================================\n"
    )
    out_path.write_text(header + yaml.safe_dump(doc, sort_keys=False), encoding="utf-8")
    print(f"Wrote {len(doc['blueprints'])} blueprints (2 root + 50 item types) to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
