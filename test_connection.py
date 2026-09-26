"""
Connection Test — checks your Dhan and Telegram credentials independently.
Run this BEFORE market hours to confirm everything is set up correctly.

Usage: python test_connection.py
"""

import requests

DHAN_ACCESS_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzg4MzY2ODM5LCJpYXQiOjE3ODgyODA0MzksInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTAwNjE2ODc3In0.LO4RypAK0jk7ngDn8-ifh1L5cwboK3xze1Hpbd0k84M0t-TWDgK6TfzjSUNCyIPCzQfnjgZ6dOYGWi7l5oHByg"
DHAN_CLIENT_ID = "1100616877"

TELEGRAM_BOT_TOKEN = "8867203270:AAHTfS8-3CVaUuTfeNId00U6J1DU9Wj0C9w"
TELEGRAM_CHAT_ID = "723433781"

DHAN_BASE = "https://api.dhan.co/v2"
HEADERS = {
    "Content-Type": "application/json",
    "access-token": DHAN_ACCESS_TOKEN,
    "client-id": DHAN_CLIENT_ID,
}


def test_dhan():
    print("\n--- Testing Dhan Connection ---")
    fund_url = f"{DHAN_BASE}/fundlimit"
    try:
        resp = requests.get(fund_url, headers=HEADERS, timeout=10)
        print(f"Trading API Status Code: {resp.status_code}")
        if resp.status_code == 200:
            data = resp.json()
            avail = data.get("availabelBalance", data.get("availableBalance", 0))
            print(f"✅ SUCCESS: Dhan Trading API Token & Client ID are VALID!")
            print(f"   Dhan Client ID: {data.get('dhanClientId')}")
            print(f"   Available Balance: ₹{avail:,.2f}")
        elif resp.status_code == 401:
            print("❌ FAILED: 401 Unauthorized — Access token is invalid or expired.")
        else:
            print(f"❌ FAILED: Response: {resp.text}")
    except Exception as e:
        print(f"❌ FAILED: Could not reach Dhan API. Error: {e}")

    print("\n--- Testing Dhan Data API (Option Chain) ---")
    option_url = f"{DHAN_BASE}/optionchain/expirylist"
    payload = {"UnderlyingScrip": 13, "UnderlyingSeg": "IDX_I"}
    try:
        resp = requests.post(option_url, headers=HEADERS, json=payload, timeout=10)
        print(f"Data API Status Code: {resp.status_code}")
        if resp.status_code == 200:
            data = resp.json()
            expiries = data.get("data", [])
            print(f"✅ SUCCESS: Data API active. Found {len(expiries)} NIFTY expiries.")
        elif "Data APIs not Subscribed" in resp.text:
            print("⚠️ NOTE: Dhan Trading API is Active, BUT Data API (₹499/mo) is not subscribed.")
        else:
            print(f"Response: {resp.text}")
    except Exception as e:
        print(f"Error checking Data API: {e}")


def test_telegram():
    print("\n--- Testing Telegram Connection ---")
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    try:
        resp = requests.post(
            url,
            json={"chat_id": TELEGRAM_CHAT_ID, "text": "✅ Test message from Dhan & Telegram straddle_alert setup!"},
            timeout=10
        )
        print(f"Telegram API Status Code: {resp.status_code}")
        if resp.status_code == 200:
            print("✅ SUCCESS: Telegram notification sent! Check your Telegram app.")
        else:
            print("❌ FAILED: Telegram response:")
            print(resp.text)
    except Exception as e:
        print(f"❌ FAILED: Could not reach Telegram API. Error: {e}")


if __name__ == "__main__":
    test_dhan()
    test_telegram()
    print("\nDone.")
