---
name: google-ux-design
description: Google Material Design 3 (M3 Expressive) & Google Workspace / Cloud Console UX craft skill for Jeopardy Studio. Use whenever designing, redesigning, or polishing React UI views, navigation, color tokens, typography, charts, steppers, or AI assistant surfaces.
---

# Google UX Design System Skill (Material 3 Expressive + Workspace Craft)

Apply these principles to every UI component, layout, and interaction in `apps/jeopardy-ui/`.

---

## 1. Core Google UX Design Tenets

1. **Tonal Elevation Over Heavy Borders:**
   - Never surround every widget with harsh 1px gray borders. Separate hierarchy using **M3 Tonal Surface Stepping**:
     - Light Canvas (`--m3-canvas`): `#F8FAFD`
     - Light Surface Container Low (`--m3-surface-low`): `#F0F4F9` (navigation rail, filter bars, recessed panels)
     - Light Surface Container (`--m3-surface-default`): `#E8EEF7` (pill search bar, unselected chips)
     - Light Elevated Sheet (`--m3-surface-sheet`): `#FFFFFF` with `rounded-[24px]` and hairline `border-[#E0E6F0]/80` + soft diffuse shadow
     - Dark Canvas (`--m3-canvas` dark — authentic Gemini / Google Workspace dark): `#131314`
     - Dark Surface Container Low: `#1E1F20`
     - Dark Surface Container: `#282A2C`
     - Dark Elevated Sheet: `#1E1F20` with subtle `border-[#333639]`
2. **Expressive Shape Scale (Generous Friendly Radii):**
   - Hero sheets & modals: `rounded-[24px]` (`24px`) or `rounded-[28px]`
   - Secondary cards & tonal containers: `rounded-2xl` (`16px`)
   - Navigation pills, search bars, filter chips, FABs, status badges: `rounded-full` (`9999px`) or `rounded-2xl` (M3 FAB squircle)
3. **Typography Hierarchy (`Plus Jakarta Sans` + `Inter` + `JetBrains Mono`):**
   - Display / Section Headings: `font-display` (`Plus Jakarta Sans`), tight tracking (`tracking-[-0.02em]`), crisp hierarchy.
   - Body / Labels: `Inter` (`13px–14px`), high contrast (`#1F1F1F` light / `#E3E3E3` dark), muted secondary `#5F6368` / `#9AA0A6`.
   - KPI Numbers & Timestamps: `tabular-nums`, bold display font; Order IDs & latency badges in `JetBrains Mono`.
4. **Google Semantic Color Tokens (Accessible AA/AAA Contrast):**
   - Primary Google Blue: `#1A73E8` (light) / `#8AB4F8` (dark) · Primary Tonal Container: `#D3E3FD` (`#041E49` text) / `#004A77` (`#C2E7FF` text in dark)
   - Healthy / Completed (Google Green): `#137333` on `#E6F4EA` (light) / `#81C995` on `#132E1C` (dark)
   - Delayed / Warning (Google Amber): `#B06000` on `#FEF7E0` (light) / `#FDD663` on `#332609` (dark)
   - Fallout / Critical (Google Red): `#C5221F` on `#FCE8E6` (light) / `#F28B82` on `#3C1919` (dark)
   - Paused / Storm Suppression (Google Indigo/Violet): `#7627BB` on `#F3E8FD` (light) / `#D7AEFB` on `#2D1B3E` (dark)

---

## 2. Shell & Layout Patterns (Google Workspace / Cloud Console)

1. **Collapsible Left Navigation Rail (`72px` collapsed / `232px` expanded):**
   - Top M3 Tonal FAB (`+ New Tracker`) in soft `#C2E7FF` (`#004A77` dark) — instant visual anchor without visual clutter.
   - Pill-shaped active nav indicator (`bg-[#D3E3FD] text-[#041E49] dark:bg-[#004A77] dark:text-[#C2E7FF] font-semibold`).
   - Clear visual separation between Care/Ops open views (`Overview`, `Order Tracker`) and Admin-gated configuration (`Workflow Studio` with Lock/Shield state).
2. **Minimalist Centered Google Pill Search Header (`64px`):**
   - Centered `rounded-full` search trigger (`bg-[#EDF2FA] dark:bg-[#282A2C]`) opening the instant `⌘K` Command Palette — eliminates hunting through menus.
   - Right cluster stays minimal: **Docked AI Assistant Toggle (`⌘J`)**, Admin session avatar pill, Theme switcher.
3. **Gemini-in-Workspace Docked AI Side Panel (`400px`):**
   - On desktop (`lg:`+), docks seamlessly beside the active workspace with zero dark blocking overlay so operators inspect Orders/Overview and interact with A2UI v0.9 cards simultaneously.
   - Context-aware: knows the active Order ID (`activeOrderId`) for 1-click explanation & lookup.
4. **Progressive Disclosure & Breathing Room:**
   - Default views show plain-English headlines, clean visual tracks, and 3–4 key KPIs.
   - Technical metadata (raw JSON payloads, ClickHouse audit rows, A2UI wire JSON, advanced filters) sits cleanly behind expandable chips/drawers.

---

## 3. Expressive Data Visualization Standards

- **Order Journey Progress Track (Google Flights / Maps Delivery Feel):**
  - Connected pill progress bar with smooth transition, numbered/checked nodes with soft concentric halo on the active/blocked step, plain-English hero sentence above, and clickable step inspection cards below.
- **Filter & Slice Chips (M3 Filter Chips):**
  - Pill buttons (`rounded-full`) with an inline checkmark when selected, soft tonal active fill (`#D3E3FD` / `#004A77`), and zero jitter on click.
- **Latency & Live Freshness Transparency:**
  - Calm live pulse dot + subtle mono query time (`4ms`), never flashing or alarming unless a real Incident Cluster is active.
