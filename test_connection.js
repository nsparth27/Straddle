const token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzg4MzY2ODM5LCJpYXQiOjE3ODgyODA0MzksInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTAwNjE2ODc3In0.LO4RypAK0jk7ngDn8-ifh1L5cwboK3xze1Hpbd0k84M0t-TWDgK6TfzjSUNCyIPCzQfnjgZ6dOYGWi7l5oHByg";
const clientId = "1100616877";
const botToken = "8867203270:AAHTfS8-3CVaUuTfeNId00U6J1DU9Wj0C9w";
const chatId = "723433781";

async function testDhan() {
  console.log("\n--- Testing Dhan Connection ---");
  const headers = {
    "access-token": token,
    "client-id": clientId,
    "Content-Type": "application/json"
  };

  try {
    const res = await fetch("https://api.dhan.co/v2/fundlimit", { headers });
    console.log("Trading API Status:", res.status);
    if (res.ok) {
      const data = await res.json();
      console.log("✅ SUCCESS: Dhan Trading API Token & Client ID are VALID!");
      console.log(`   Client ID: ${data.dhanClientId}`);
      console.log(`   Available Balance: ₹${data.availabelBalance ?? data.availableBalance}`);
    } else {
      console.log("❌ FAILED:", await res.text());
    }
  } catch (err) {
    console.error("❌ FAILED to connect to Dhan:", err.message);
  }

  console.log("\n--- Testing Dhan Data API (Option Chain) ---");
  try {
    const res = await fetch("https://api.dhan.co/v2/optionchain/expirylist", {
      method: "POST",
      headers,
      body: JSON.stringify({ UnderlyingScrip: 13, UnderlyingSeg: "IDX_I" })
    });
    const text = await res.text();
    if (res.ok) {
      console.log("✅ SUCCESS: Data API is active.");
    } else if (text.includes("Data APIs not Subscribed")) {
      console.log("⚠️ NOTE: Dhan Trading API is Active, BUT Data API (₹499/mo) is not subscribed.");
    } else {
      console.log("Data API Response:", text);
    }
  } catch (err) {
    console.error("Data API check failed:", err.message);
  }
}

async function testTelegram() {
  console.log("\n--- Testing Telegram Connection ---");
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: "✅ Test message from Dhan & Telegram straddle_alert setup!" })
    });
    if (res.ok) {
      console.log("✅ SUCCESS: Telegram notification sent! Check your Telegram app.");
    } else {
      console.log("❌ FAILED Telegram response:", await res.text());
    }
  } catch (err) {
    console.error("❌ FAILED to connect to Telegram:", err.message);
  }
}

(async () => {
  await testDhan();
  await testTelegram();
  console.log("\nDone.");
})();
