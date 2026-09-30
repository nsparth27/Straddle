const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));

async function inspectAccuracy() {
  const headers = {
    'access-token': cfg.dhanAccessToken,
    'client-id': cfg.dhanClientId,
    'Content-Type': 'application/json'
  };

  const testList = [
    { name: 'NIFTY', secId: '13', seg: 'IDX_I', inst: 'INDEX' },
    { name: 'BANKNIFTY', secId: '25', seg: 'IDX_I', inst: 'INDEX' },
    { name: 'FINNIFTY', secId: '27', seg: 'IDX_I', inst: 'INDEX' },
    { name: 'RELIANCE', secId: '2885', seg: 'NSE_EQ', inst: 'EQUITY' },
    { name: 'TCS', secId: '11536', seg: 'NSE_EQ', inst: 'EQUITY' },
    { name: 'INFY', secId: '1594', seg: 'NSE_EQ', inst: 'EQUITY' },
    { name: 'HDFCBANK', secId: '1333', seg: 'NSE_EQ', inst: 'EQUITY' },
    { name: 'ICICIBANK', secId: '4963', seg: 'NSE_EQ', inst: 'EQUITY' }
  ];

  console.log('================================================================');
  console.log('     EXCHANGE VERIFICATION: RAW DHAN DATA AUDIT');
  console.log('================================================================\n');

  for (const s of testList) {
    // 1. Dhan Historical OHLC
    const dRes = await fetch('https://api.dhan.co/v2/charts/historical', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        securityId: s.secId,
        exchangeSegment: s.seg,
        instrument: s.inst,
        expiryCode: 0,
        fromDate: '2026-09-01',
        toDate: '2026-09-30'
      })
    });
    const dData = await dRes.json();
    const len = dData.open ? dData.open.length : 0;

    // 2. Dhan Option Chain
    let expiry = null;
    let ocData = null;
    try {
      const expRes = await fetch('https://api.dhan.co/v2/optionchain/expirylist', {
        method: 'POST',
        headers,
        body: JSON.stringify({ UnderlyingScrip: s.secId, UnderlyingSeg: s.seg })
      });
      if (expRes.ok) {
        const expJson = await expRes.json();
        expiry = expJson.data ? expJson.data[0] : null;
        if (expiry) {
          await new Promise(r => setTimeout(r, 120));
          const ocRes = await fetch('https://api.dhan.co/v2/optionchain', {
            method: 'POST',
            headers,
            body: JSON.stringify({ UnderlyingScrip: s.secId, UnderlyingSeg: s.seg, Expiry: expiry })
          });
          if (ocRes.ok) {
            ocData = await ocRes.json();
          }
        }
      }
    } catch (e) {}

    console.log(`📌 INSTRUMENT: ${s.name} (${s.seg})`);
    if (len >= 2) {
      const lastDate = new Date(dData.timestamp[len-1] * 1000).toISOString().split('T')[0];
      const prevDate = new Date(dData.timestamp[len-2] * 1000).toISOString().split('T')[0];
      console.log(`   Session Date:     ${lastDate} (Prev: ${prevDate})`);
      console.log(`   Today Open:       ₹${dData.open[len-1]}`);
      console.log(`   Today High:       ₹${dData.high[len-1]}`);
      console.log(`   Today Low:        ₹${dData.low[len-1]}`);
      console.log(`   Today Close(LTP): ₹${dData.close[len-1]}`);
      console.log(`   Prev High (PDH):  ₹${dData.high[len-2]}`);
      console.log(`   Prev Close:       ₹${dData.close[len-2]}`);
    }

    if (ocData && ocData.data && ocData.data.oc) {
      const spot = ocData.data.last_price;
      const strikes = Object.keys(ocData.data.oc).map(Number).filter(n => !isNaN(n));
      if (strikes.length > 0 && spot) {
        const atm = strikes.reduce((p, c) => Math.abs(c - spot) < Math.abs(p - spot) ? c : p);
        const leg = ocData.data.oc[String(atm)];
        if (leg) {
          const ce = leg.ce?.last_price || 0;
          const pe = leg.pe?.last_price || 0;
          console.log(`   Option Expiry:    ${expiry} | ATM Strike: ${atm}`);
          console.log(`   CE LTP: ₹${ce} | PE LTP: ₹${pe} --> Live Straddle: ₹${(ce + pe).toFixed(2)}`);
        }
      }
    }
    console.log('----------------------------------------------------------------');
    await new Promise(r => setTimeout(r, 200));
  }
}

inspectAccuracy();
