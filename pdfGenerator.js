const PDFDocument = require('pdfkit');

/**
 * Generate a high-resolution Bloomberg-style executive PDF report
 * @param {Array} dataset - Array of instrument objects
 * @param {Object} meta - Metadata including date, time, kpis
 * @returns {Promise<Buffer>} - Resolves to PDF binary Buffer
 */
function generateExecutivePdfReport(dataset = [], meta = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margin: 30,
        bufferPages: true,
        info: {
          Title: `Dhan Straddle Pro Intelligence Report - ${meta.date || 'Today'}`,
          Author: 'Bloomberg Terminal Engine',
          Subject: 'Real-Time F&O Straddle & Breakout Verification'
        }
      });

      const buffers = [];
      doc.on('data', chunk => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const targetDate = meta.date || new Date().toISOString().split('T')[0];
      const timeStr = meta.time || new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
      const totalCount = dataset.length;
      const breakoutRows = dataset.filter(d => d.todayHigh > d.prevDayHigh || d.straddlePrice > d.prevDayHighStraddle);
      const breakoutCount = breakoutRows.length;
      const advances = dataset.filter(d => d.pctChange > 0).length;
      const declines = dataset.filter(d => d.pctChange < 0).length;

      const primaryColor = '#FFB000'; // Amber
      const secondaryColor = '#00E5FF'; // Cyan
      const greenColor = '#00873D'; // Darker readable green
      const redColor = '#D32F2F'; // Red
      const headerBg = '#141923';
      const textMain = '#111827';
      const textMuted = '#6B7280';
      const cardBg = '#F3F4F6';
      const borderColor = '#E5E7EB';

      // ==========================================
      // PAGE 1: EXECUTIVE SUMMARY & TOP BREAKOUTS
      // ==========================================

      // Top Title Bar
      doc.rect(30, 25, 782, 45).fill('#0F172A');
      doc.fontSize(16).fillColor('#FFB000').font('Helvetica-Bold').text('BLOOMBERG TERMINAL — DHAN STRADDLE PRO', 45, 34);
      doc.fontSize(9).fillColor('#38BDF8').font('Helvetica').text('INSTITUTIONAL F&O BREAKOUT INTELLIGENCE & MULTI-ASSET VERIFIER REPORT', 45, 52);

      // Date / Info Box (Right aligned inside title bar)
      doc.fontSize(8).fillColor('#94A3B8').font('Helvetica').text(`DATE: ${targetDate}  |  GENERATED: ${timeStr} IST`, 520, 36, { align: 'right', width: 280 });
      doc.fontSize(8).fillColor('#4ADE80').font('Helvetica-Bold').text(`UNIVERSE: 217 ASSETS (208 F&O • 4 INDICES • 5 MCX)`, 520, 50, { align: 'right', width: 280 });

      // KPI Metric Cards
      const cardY = 80;
      const cardWidth = 185;
      const cardHeight = 48;
      const cardGap = 14;

      const kpis = [
        { label: 'TOTAL ASSETS MONITORED', value: String(totalCount), sub: '208 F&O • 4 IDX • 5 MCX', color: '#1E293B' },
        { label: 'ACTIVE PDH BREAKOUTS', value: String(breakoutCount), sub: `${((breakoutCount / (totalCount || 1)) * 100).toFixed(1)}% of monitored universe`, color: breakoutCount > 0 ? '#16A34A' : '#64748B' },
        { label: 'MARKET BREADTH', value: `${advances} ▲ / ${declines} ▼`, sub: advances >= declines ? 'Net Bullish Advance' : 'Net Bearish Decline', color: advances >= declines ? '#16A34A' : '#DC2626' },
        { label: 'STRATEGY REGIME', value: breakoutCount > 15 ? 'EXPANSION' : 'THETA DECAY', sub: breakoutCount > 15 ? 'Gamma Volatility Spikes' : 'Straddle Contraction Dominance', color: '#0284C7' }
      ];

      kpis.forEach((kpi, idx) => {
        const x = 30 + idx * (cardWidth + cardGap);
        doc.rect(x, cardY, cardWidth, cardHeight).fillAndStroke(cardBg, borderColor);
        doc.fontSize(7).fillColor(textMuted).font('Helvetica-Bold').text(kpi.label, x + 8, cardY + 7);
        doc.fontSize(14).fillColor(kpi.color).font('Helvetica-Bold').text(kpi.value, x + 8, cardY + 18);
        doc.fontSize(7).fillColor(textMuted).font('Helvetica').text(kpi.sub, x + 8, cardY + 35);
      });

      // Breakouts Section Header
      const brkHeaderY = 140;
      doc.rect(30, brkHeaderY, 782, 22).fill('#1E293B');
      doc.fontSize(9).fillColor('#FBBF24').font('Helvetica-Bold').text(`🔥 ACTIVE BREAKOUT LEADERS (TODAY HIGH > PREV DAY HIGH)`, 40, brkHeaderY + 6);
      doc.fontSize(8).fillColor('#E2E8F0').font('Helvetica').text(`Count: ${breakoutRows.length} stocks`, 720, brkHeaderY + 6);

      // Table Column Definitions
      const columns = [
        { header: '#', width: 25, align: 'center', key: 'idx' },
        { header: 'SYMBOL', width: 85, align: 'left', key: 'name' },
        { header: 'SEGMENT', width: 60, align: 'center', key: 'segment' },
        { header: 'SPOT (₹)', width: 65, align: 'right', key: 'spot' },
        { header: 'ATM', width: 45, align: 'center', key: 'atm' },
        { header: 'STRADDLE (₹)', width: 75, align: 'right', key: 'straddle' },
        { header: 'STRAD PDH (₹)', width: 75, align: 'right', key: 'stradPdh' },
        { header: 'PREV HIGH (₹)', width: 75, align: 'right', key: 'prevHigh' },
        { header: 'TODAY HIGH (₹)', width: 75, align: 'right', key: 'todayHigh' },
        { header: 'NET CHG %', width: 60, align: 'right', key: 'pctChange' },
        { header: 'HIGH vs PDH %', width: 70, align: 'right', key: 'pdhPctDiff' },
        { header: 'STATUS', width: 72, align: 'center', key: 'status' }
      ];

      function drawTableHeader(y) {
        doc.rect(30, y, 782, 16).fill('#334155');
        let curX = 30;
        columns.forEach(col => {
          doc.fontSize(7.5).fillColor('#FFFFFF').font('Helvetica-Bold').text(col.header, curX, y + 4, { width: col.width, align: col.align });
          curX += col.width;
        });
      }

      function drawTableRow(item, idx, y, isAlternate, isBreakoutRow = false) {
        if (isBreakoutRow) {
          doc.rect(30, y, 782, 14).fill('#FEF3C7'); // Soft highlight for breakouts
        } else if (isAlternate) {
          doc.rect(30, y, 782, 14).fill('#F8FAFC');
        }

        const isBreakout = item.todayHigh > item.prevDayHigh;
        const pdh = item.prevDayHigh || 1;
        const pdhPct = (((item.todayHigh - pdh) / pdh) * 100).toFixed(2);
        const pctChg = Number(item.pctChange || 0);

        let curX = 30;
        columns.forEach(col => {
          let text = '';
          let color = '#0F172A';

          switch (col.key) {
            case 'idx': text = String(idx + 1); color = textMuted; break;
            case 'name': text = item.name; color = '#0F172A'; break;
            case 'segment': text = item.segment; color = textMuted; break;
            case 'spot': text = Number(item.todayClose || item.todayOpen || 0).toFixed(2); break;
            case 'atm': text = String(item.atmStrike || '--'); break;
            case 'straddle': text = Number(item.straddlePrice || 0).toFixed(2); color = isBreakout ? '#059669' : '#0F172A'; break;
            case 'stradPdh': text = Number(item.prevDayHighStraddle || 0).toFixed(2); color = textMuted; break;
            case 'prevHigh': text = Number(item.prevDayHigh || 0).toFixed(2); break;
            case 'todayHigh': text = Number(item.todayHigh || 0).toFixed(2); color = isBreakout ? '#059669' : '#0F172A'; break;
            case 'pctChange':
              text = (pctChg >= 0 ? '+' : '') + pctChg.toFixed(2) + '%';
              color = pctChg > 0 ? '#16A34A' : (pctChg < 0 ? '#DC2626' : textMuted);
              break;
            case 'pdhPctDiff':
              text = (Number(pdhPct) >= 0 ? '+' : '') + pdhPct + '%';
              color = isBreakout ? '#16A34A' : textMuted;
              break;
            case 'status':
              text = isBreakout ? 'BREAKOUT' : 'NORMAL';
              color = isBreakout ? '#D97706' : textMuted;
              break;
          }

          doc.fontSize(7).fillColor(color).font(isBreakout && (col.key === 'name' || col.key === 'status') ? 'Helvetica-Bold' : 'Helvetica').text(text, curX, y + 3, { width: col.width, align: col.align });
          curX += col.width;
        });

        // Bottom gridline
        doc.moveTo(30, y + 14).lineTo(812, y + 14).strokeColor('#E2E8F0').lineWidth(0.5).stroke();
      }

      // Draw Top Breakouts on Page 1
      let currentY = brkHeaderY + 22;
      drawTableHeader(currentY);
      currentY += 16;

      const topBreakouts = breakoutRows.slice(0, 24);
      if (topBreakouts.length === 0) {
        doc.rect(30, currentY, 782, 30).fill('#F8FAFC');
        doc.fontSize(9).fillColor(textMuted).font('Helvetica').text('No instruments crossed their Previous Day High in this session snapshot.', 40, currentY + 10, { align: 'center', width: 760 });
        currentY += 30;
      } else {
        topBreakouts.forEach((item, idx) => {
          drawTableRow(item, idx, currentY, idx % 2 === 1, true);
          currentY += 14;
        });
      }

      // ==========================================
      // PAGES 2+: FULL 217-INSTRUMENT MARKET DATASET
      // ==========================================
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 30 });

      // Page 2 Header
      doc.rect(30, 25, 782, 28).fill('#0F172A');
      doc.fontSize(12).fillColor('#FFB000').font('Helvetica-Bold').text('COMPLETE 217-INSTRUMENT F&O & MCX VERIFICATION DATASET', 45, 33);
      doc.fontSize(8).fillColor('#94A3B8').font('Helvetica').text(`Session: ${targetDate}  |  Dhan Live Batch & Daily OHLC`, 520, 35, { align: 'right', width: 280 });

      currentY = 60;
      drawTableHeader(currentY);
      currentY += 16;

      const rowHeight = 14;
      const maxY = 540;

      dataset.forEach((item, idx) => {
        if (currentY + rowHeight > maxY) {
          doc.addPage({ size: 'A4', layout: 'landscape', margin: 30 });
          // Repeat header on new page
          doc.rect(30, 25, 782, 28).fill('#0F172A');
          doc.fontSize(12).fillColor('#FFB000').font('Helvetica-Bold').text('COMPLETE 217-INSTRUMENT F&O & MCX VERIFICATION DATASET (Contd.)', 45, 33);
          doc.fontSize(8).fillColor('#94A3B8').font('Helvetica').text(`Session: ${targetDate}  |  Page Table Feed`, 520, 35, { align: 'right', width: 280 });
          currentY = 60;
          drawTableHeader(currentY);
          currentY += 16;
        }

        const isBrk = item.todayHigh > item.prevDayHigh;
        drawTableRow(item, idx, currentY, idx % 2 === 1, isBrk);
        currentY += rowHeight;
      });

      // Add Page Numbers and Footer to all pages
      const totalPages = doc.bufferedPageRange().count;
      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(i);
        doc.rect(30, 560, 782, 18).fill('#F1F5F9');
        doc.fontSize(7).fillColor('#64748B').font('Helvetica').text(
          `Bloomberg Terminal — Dhan Straddle Pro  •  Confidential Market Intelligence Report  •  Page ${i + 1} of ${totalPages}`,
          30, 565, { align: 'center', width: 782 }
        );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generateExecutivePdfReport
};
