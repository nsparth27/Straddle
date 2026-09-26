"""
ATM Straddle Breakout Alert
----------------------------
Watches the ATM (at-the-money) straddle price (ATM Call LTP + ATM Put LTP)
for a list of symbols/indices on Dhan, builds 15-minute bars of the straddle
price, and sends a Telegram alert the moment the *current* straddle price
breaks ABOVE the *previous completed* 15-minute bar's close.

Usage:
1. Fill in the CONFIG section below.
2. Run: python straddle_alert.py
"""

import requests
import time
from datetime import datetime, timezone, timedelta

# =========================== CONFIG ===========================

# Dhan Credentials (Active 24-hr Token)
DHAN_ACCESS_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzg4NTgwNjE3LCJpYXQiOjE3ODg0OTQyMTcsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTAwNjE2ODc3In0.5d5uacNWSgKmXD79tYJp6sOy2EeNf1H4wUyGajFCWrD7TyqOtTxpaq3MWNus0tvdZEEaTSXeTCSVbqP6pTNABQ"
DHAN_CLIENT_ID = "1100616877"

# Telegram Credentials
TELEGRAM_BOT_TOKEN = "8867203270:AAHTfS8-3CVaUuTfeNId00U6J1DU9Wj0C9w"
TELEGRAM_CHAT_ID = "723433781"  # Parth Shah's Telegram Chat ID


WATCHLIST = [
    {"name": "NIFTY",     "security_id": 13,    "segment": "IDX_I"},
    {"name": "BANKNIFTY", "security_id": 25,    "segment": "IDX_I"},
]

POLL_INTERVAL_SECONDS = 15   # how often to check each symbol's live straddle price
API_CALL_GAP_SECONDS = 3.5   # gap between Dhan API calls (rate limit safety)
BAR_MINUTES = 15

# Standard IST Timezone without external library dependency
IST = timezone(timedelta(hours=5, minutes=30))

# ================================================================

DHAN_BASE = "https://api.dhan.co/v2"
HEADERS = {
    "Content-Type": "application/json",
    "access-token": DHAN_ACCESS_TOKEN,
    "client-id": DHAN_CLIENT_ID,
}


def send_telegram_alert(message: str):
    """Sends notification to Telegram chat."""
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    try:
        resp = requests.post(url, json={"chat_id": TELEGRAM_CHAT_ID, "text": message, "parse_mode": "HTML"}, timeout=10)
        if resp.status_code == 200:
            print("[Telegram] Alert sent successfully!")
        else:
            print(f"[Telegram Error] {resp.status_code}: {resp.text}")
    except Exception as e:
        print(f"[Telegram Error] {e}")


def get_nearest_expiry(security_id: int, segment: str) -> str:
    url = f"{DHAN_BASE}/optionchain/expirylist"
    payload = {"UnderlyingScrip": security_id, "UnderlyingSeg": segment}
    resp = requests.post(url, headers=HEADERS, json=payload, timeout=10)
    
    if resp.status_code == 401:
        print("❌ FAILED: 401 Unauthorized — your Dhan access token is wrong or expired.")
        return None
    elif "Data APIs not Subscribed" in resp.text:
        print("⚠️ NOTE: Data API (₹499/mo) is not subscribed on Dhan for Option Chain feed.")
        return None

    if not resp.ok:
        print(f"❌ Error fetching expiry: {resp.status_code} {resp.text}")
        return None

    data = resp.json()
    expiries = data.get("data", [])
    if not expiries:
        print(f"⚠️ No expiries found for security_id={security_id}")
        return None
    return expiries[0]  # nearest expiry


def get_option_chain(security_id: int, segment: str, expiry: str) -> dict:
    url = f"{DHAN_BASE}/optionchain"
    payload = {"UnderlyingScrip": security_id, "UnderlyingSeg": segment, "Expiry": expiry}
    resp = requests.post(url, headers=HEADERS, json=payload, timeout=10)
    if not resp.ok:
        return None
    return resp.json()


def get_atm_straddle_price(chain_response: dict):
    """Returns (atm_strike, straddle_price, spot_price) from a Dhan option chain response."""
    if not chain_response:
        return None, None, None

    data = chain_response.get("data", {})
    spot = data.get("last_price")
    oc = data.get("oc", {})
    if spot is None or not oc:
        return None, None, None

    # Find the strike closest to spot price
    strikes = [float(k) for k in oc.keys()]
    atm_strike = min(strikes, key=lambda s: abs(s - spot))

    strike_key = next(k for k in oc.keys() if float(k) == atm_strike)
    leg = oc[strike_key]
    ce_ltp = leg.get("ce", {}).get("last_price")
    pe_ltp = leg.get("pe", {}).get("last_price")
    if ce_ltp is None or pe_ltp is None:
        return atm_strike, None, spot

    straddle_price = round(ce_ltp + pe_ltp, 2)
    return atm_strike, straddle_price, spot


def current_bar_start(dt: datetime) -> datetime:
    """Floors a datetime down to the start of its 15-minute bar."""
    minute = (dt.minute // BAR_MINUTES) * BAR_MINUTES
    return dt.replace(minute=minute, second=0, microsecond=0)


def is_market_open(dt: datetime) -> bool:
    if dt.weekday() >= 5:  # Sat/Sun
        return False
    open_t = dt.replace(hour=9, minute=15, second=0, microsecond=0)
    close_t = dt.replace(hour=15, minute=30, second=0, microsecond=0)
    return open_t <= dt <= close_t


class SymbolTracker:
    """Tracks 15-minute straddle bars for a single symbol and fires alerts on upward breakout."""

    def __init__(self, name, security_id, segment):
        self.name = name
        self.security_id = security_id
        self.segment = segment
        self.expiry = None
        self.current_bar_start = None
        self.prev_bar_close = None   # close of the last COMPLETED bar
        self.running_price = None    # latest price within the current (still-forming) bar
        self.alerted_this_bar = False

    def ensure_expiry(self):
        if self.expiry is None:
            self.expiry = get_nearest_expiry(self.security_id, self.segment)
            if self.expiry:
                print(f"[{self.name}] Using expiry {self.expiry}")

    def update(self, now_ist: datetime):
        self.ensure_expiry()
        if not self.expiry:
            return

        chain = get_option_chain(self.security_id, self.segment, self.expiry)
        atm_strike, straddle_price, spot = get_atm_straddle_price(chain)

        if straddle_price is None:
            print(f"[{self.name}] No straddle price available right now.")
            return

        bar_start = current_bar_start(now_ist)

        # First data point ever
        if self.current_bar_start is None:
            self.current_bar_start = bar_start
            self.running_price = straddle_price
            print(f"[{self.name}] Init straddle={straddle_price} (strike {atm_strike}, spot {spot})")
            return

        # New bar started -> the previous running_price becomes the completed bar's close
        if bar_start != self.current_bar_start:
            self.prev_bar_close = self.running_price
            self.current_bar_start = bar_start
            self.alerted_this_bar = False
            print(f"[{self.name}] New 15-min bar. Previous bar close = {self.prev_bar_close}")

        self.running_price = straddle_price

        print(f"[{self.name}] strike={atm_strike} spot={spot} straddle={straddle_price} "
              f"prev_bar_close={self.prev_bar_close}")

        # Breakout check: current straddle price rises above previous completed bar's close
        if (self.prev_bar_close is not None
                and not self.alerted_this_bar
                and straddle_price > self.prev_bar_close):
            pct_move = round((straddle_price - self.prev_bar_close) / self.prev_bar_close * 100, 2)
            msg = (f"🚀 <b>STRADDLE BREAKOUT UP: {self.name}</b>\n\n"
                   f"<b>ATM Strike:</b> {atm_strike}\n"
                   f"<b>Straddle Price:</b> ₹{straddle_price} (prev 15m close: ₹{self.prev_bar_close}, +{pct_move}%)\n"
                   f"<b>Spot:</b> {spot}\n"
                   f"<b>Time:</b> {now_ist.strftime('%H:%M:%S')}")
            print(msg)
            send_telegram_alert(msg)
            self.alerted_this_bar = True


def main():
    print(f"🚀 Dhan ATM Straddle Alert System Started")
    print(f"📱 Telegram Bot: Configured")
    print(f"🔑 Dhan Client ID: {DHAN_CLIENT_ID}")
    
    trackers = [SymbolTracker(s["name"], s["security_id"], s["segment"]) for s in WATCHLIST]
    print(f"Watching {len(trackers)} symbol(s) for ATM straddle upward breakouts...\n")

    send_telegram_alert(f"🟢 <b>Straddle Monitor Started</b>\nWatching: {', '.join([s['name'] for s in WATCHLIST])}")

    while True:
        now_ist = datetime.now(IST)

        if not is_market_open(now_ist):
            print(f"[{now_ist.strftime('%H:%M:%S IST')}] Market closed. Sleeping 60s...")
            time.sleep(60)
            continue

        for tracker in trackers:
            try:
                tracker.update(now_ist)
            except Exception as e:
                print(f"[{tracker.name}] Error: {e}")
            time.sleep(API_CALL_GAP_SECONDS)

        time.sleep(max(0, POLL_INTERVAL_SECONDS - len(trackers) * API_CALL_GAP_SECONDS))


if __name__ == "__main__":
    main()
