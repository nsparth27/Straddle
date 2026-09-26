# Implementation Plan: Straddle PDH Breakout Alert, MCX Commodities & Detailed EOD Multi-Cross Report

## Goal Description
Enhance the Dhan Straddle Pro system with three major capabilities:
1. **Previous Day High (PDH) Alert Rule with 1-Alert-Per-Day Limit**: Transition from previous 15-minute close/bar breakout to Previous Day High (PDH) breakout, guaranteeing strictly **1 alert per stock per day**.
2. **MCX Commodities Integration**: Enable fetching and tracking of MCX commodities (Crude Oil, Natural Gas, Gold, Silver, Copper) with extended commodity market hours (09:00 AM - 11:30 PM / 11:55 PM IST) and identical PDH breakout alerts.
3. **Upgraded Evening EOD Report (Time-wise Multi-Cross Tracking)**: Redesign the EOD summary report to **strictly include only stocks that crossed their Previous Day High**, detailing:
   - Total number of times each stock crossed above PDH (e.g., crossed 1 time, 2 times, 3 times).
   - Time-wise timeline of each cross event (Crossover Time, Crossing Price, Peak Reached, and Dip/Retracement time).

---

## Technical Specifications

### 1. Previous Day High (PDH) Baseline Definition
* For ATM Straddles, PDH is determined from yesterday's highest recorded ATM straddle level (or yesterday's daily candle peak).
* For spot/underlying, it uses the official NSE/MCX settled Previous Day High. Both levels are tracked.

### 2. 1-Alert-Per-Day Guarantee
* Once an alert is triggered for a symbol on a given trading day, it is flagged with `pdhAlertSentDate: 'YYYY-MM-DD'`.
* Even if the price drops below PDH and surges past PDH again multiple times, live Telegram alerts are suppressed for the rest of the day for that symbol to avoid spam.
* **All crossover timestamps and peak values are continuously tracked and compiled into the Evening EOD Report**.

### 3. MCX Market Hours
* **NSE Equities & Indices**: 09:15 AM - 03:30 PM IST (Mon-Fri).
* **MCX Commodities**: 09:00 AM - 11:30 PM / 11:55 PM IST (Mon-Fri).
* The polling engine dynamically processes symbols according to their market segment.

---

## Architecture Flow

```
+-------------------------------------------------------------+
|                     Master Polling Loop                     |
+-------------------------------------------------------------+
                              |
            +-----------------+-----------------+
            |                                   |
     [NSE Segment]                       [MCX Segment]
  (09:15 - 15:30 IST)                 (09:00 - 23:30 IST)
            |                                   |
            +-----------------+-----------------+
                              |
                              v
             Fetch Live Option Chain & Spot Data
                              |
                              v
                 Calculate Live ATM Straddle
                              |
                              v
           +-------------------------------------+
           | Straddle Price > Previous Day High? |
           +-------------------------------------+
                  |                        |
                (YES)                     (NO)
                  |                        |
       +----------+----------+             |
       |                     |             v
 [New Crossover]   [Ongoing Crossover]   [Below PDH / Dipped]
Record Start Time,  Update Peak Price    Record Dip Timestamp
Price & Peak Level
       |
       v
+-----------------------------+
| Alert Sent Today for Stock? |
+-----------------------------+
       |               |
     (NO)            (YES)
       |               |
       v               v
  🚀 Send 1-Time  Suppress Alert
  Telegram Alert  (Keep in Log)
  & Mark Sent
```

---

## Proposed File Changes

### 1. `server.js` (Core Engine)
- **Previous Day High Calculation**: Fetch yesterday's high from Dhan Historical Daily Bar API (`/v2/charts/historical` or `/v2/charts/intraday`) and store `prevDayHighStraddle` / `prevDayHighSpot`.
- **Single Alert Per Stock Per Day**: Add `pdhAlertSentDate` check so each stock sends at most 1 Telegram alert per day upon crossing PDH.
- **Multi-Cross Event Tracker**: Maintain `crossoverEvents: []` recording `{ crossNum, startTime, startPrice, peakPrice, dipTime }`.
- **Segment Market Hours**: Support `MCX_COMM` trading hours (09:00 - 23:30 IST).
- **Evening EOD Report Overhaul**:
  - Filter list to ONLY include stocks where `crossoverEvents.length > 0`.
  - Format time-wise breakdown for each crossover with timestamps, cross price, peak, and dip time.

### 2. `config.json` (Watchlist & Settings)
- Add MCX commodity contracts (`CRUDEOIL`, `NATURALGAS`, `GOLD`, `SILVER`, `COPPER`) under segment `MCX_COMM`.

### 3. `public/index.html` & `public/app.js` (Web Terminal UI)
- Add "Commodities" filter pill.
- Add "Prev Day High" and "Cross Count" columns in the real-time table.
- Display crossover timeline for selected stocks.

---

## Sub-Agent Work Breakdown

| Work Stream | Tasks |
|---|---|
| **Core Engine & PDH Tracker** | Implement PDH calculations, single-alert throttling, and crossover event tracker in `server.js`. |
| **Commodities Integration** | Add MCX commodity contracts to `config.json` and handle MCX market hours in `server.js`. |
| **EOD Report Dispatcher** | Implement time-wise crossover timeline reporting and strict filter in `server.js`. |
| **Terminal UI & Verification** | Update `public/index.html`, `public/app.js`, and verify with diagnostic tests. |
