// Builds synthetic test documents with known answers (fictional parties and numbers):
//   docs/SYN1/CommercialInvoice_ANIT-EXP-2025-0716_synthetic.pdf  (same air shipment as the HAWB + packing list)
//   docs/SYN2/BL_GSLU-JEA-77120_synthetic.pdf + SYN2/PackingList_GSL-0457_synthetic.pdf  (sea shipment, 2 containers)
//   npx tsx eval/synthetic/make.ts
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const here = import.meta.dirname;

async function page(draw: (t: (s: string, x: number, y: number, o?: { size?: number; bold?: boolean }) => void, line: (x0: number, y0: number, x1: number, y1: number) => void) => void) {
  const doc = await PDFDocument.create();
  const p = doc.addPage([595, 842]);
  const f = await doc.embedFont(StandardFonts.Helvetica), b = await doc.embedFont(StandardFonts.HelveticaBold);
  draw((s, x, y, o = {}) => p.drawText(s, { x, y: 842 - y, size: o.size ?? 8, font: o.bold ? b : f }), (x0, y0, x1, y1) => p.drawLine({ start: { x: x0, y: 842 - y0 }, end: { x: x1, y: 842 - y1 }, thickness: 0.5, color: rgb(0.4, 0.4, 0.4) }));
  return doc.save();
}

// ---- commercial invoice (air, SYN1)
const ci = await page((t, ln) => {
  t('AL NOOR INFORMATION TECHNOLOGY LLC', 35, 45, { size: 11, bold: true }); t('COMMERCIAL INVOICE', 420, 45, { size: 12, bold: true });
  t('Office 603, Al Ghurair Business Bldg, Port Saeed', 35, 58); t('Deira, Dubai, United Arab Emirates', 35, 68); t('TRN: 100384726500003', 35, 78);
  t('Bill To / Consignee', 35, 110, { bold: true }); t('MARGALLA SYSTEMS (PVT) LTD', 35, 121); t('Plot 18, Jinnah Avenue, Blue Area', 35, 131); t('Islamabad 44000, Pakistan', 35, 141);
  t('Invoice No: ANIT/EXP/2025/0716', 320, 110); t('Invoice Date: 16-JUL-2025', 320, 121); t('Customer PO: MSL-PO-88213', 320, 132);
  t('HAWB No: GML-DXB-2043   MAWB No: 888-44183020', 320, 143); t('Terms: FCA Dubai (Incoterms 2020)', 320, 154); t('Payment: 30 days net', 320, 165);
  t('Country of Origin: Malaysia', 320, 176); t('Currency: USD', 320, 187);
  ln(35, 205, 560, 205);
  const X = [35, 55, 120, 270, 330, 365, 395, 425, 485];
  ['Item', 'Part No', 'Description', 'HS Code', 'Origin', 'Qty', 'Unit', 'Unit Price', 'Amount'].forEach((h, i) => t(h, X[i], 216, { bold: true }));
  ln(35, 221, 560, 221);
  const rows = [
    ['1', 'NSA-4300', 'Network security appliance NSA-4300', '8517.69', 'MY', '2', 'PC', '4,850.00', '9,700.00'],
    ['2', 'PC-C13-EU', 'Power cord, EU type (C13)', '8544.42', 'CN', '2', 'PC', '6.50', '13.00'],
    ['3', 'PC-C13-UK', 'Power cord, UK type (C13)', '8544.42', 'CN', '2', 'PC', '7.25', '14.50'],
    ['4', 'RMK-4300', 'Rack-mount kit and quick-start guide', '8517.79', 'MY', '1', 'SET', '95.00', '95.00'],
    ['5', 'SFP-10G-SR', 'SFP+ 10G SR transceiver module', '8517.79', 'TW', '2', 'PC', '120.00', '240.00'],
    ['6', 'RMK-4300B', 'Rack-mount kit, spare', '8517.79', 'MY', '1', 'SET', '95.00', '95.00'],
  ];
  rows.forEach((r, k) => r.forEach((c, i) => t(c, X[i], 234 + k * 14)));
  ln(35, 320, 560, 320);
  t('TOTAL', 35, 332, { bold: true }); t('10', 365, 332, { bold: true }); t('USD 10,157.50', 485, 332, { bold: true });
  t('Amount in words: US Dollars Ten Thousand One Hundred Fifty-Seven and 50/100 only', 35, 360);
  t('Net Weight: 26.80 KG   Gross Weight: 30.00 KG   Packages: 2 CARTONS', 35, 374);
  t('Synthetic document for OCR/IDP testing. Fictional parties and numbers. Not valid for customs.', 35, 820, { size: 6 });
});
await writeFile(path.join(here, 'docs/SYN1/CommercialInvoice_ANIT-EXP-2025-0716_synthetic.pdf'), ci);

// ---- sea BL (SYN2): goods block, 2 containers with seals, weights, CBM
const bl = await page((t, ln) => {
  t('BILL OF LADING', 380, 40, { size: 13, bold: true }); t('B/L No. GSLU-JEA-77120', 380, 56, { bold: true });
  t('Shipper', 35, 40, { bold: true }); t('GULF STEEL LINES TRADING LLC', 35, 51); t('Jebel Ali Free Zone, Dubai, UAE', 35, 61);
  t('Consignee', 35, 85, { bold: true }); t('KARACHI FASTENERS (PVT) LTD', 35, 96); t('Plot 12, SITE Area, Karachi, Pakistan', 35, 106);
  t('Notify Party', 35, 130, { bold: true }); t('SAME AS CONSIGNEE', 35, 141);
  t('Vessel', 35, 170, { bold: true }); t('Voyage', 200, 170, { bold: true }); t('MAERSK KENSINGTON', 35, 181); t('427W', 200, 181);
  t('Port of loading', 35, 200, { bold: true }); t('Port of discharge', 200, 200, { bold: true }); t('JEBEL ALI, UAE', 35, 211); t('KARACHI, PAKISTAN', 200, 211);
  ln(35, 230, 560, 230);
  t('Marks and Numbers', 35, 241, { bold: true }); t('Number and kind of packages; Description of goods', 160, 241, { bold: true }); t('Gross Weight', 420, 241, { bold: true }); t('Measurement', 495, 241, { bold: true });
  ln(35, 246, 560, 246);
  t('KFL/KHI/01-40', 35, 260); t('40 PALLETS', 160, 260); t('STEEL HEX BOLTS AND NUTS, ZINC PLATED', 160, 271); t('HS CODE: 7318.15', 160, 282);
  t('PO: KFL-PO-5521', 160, 293); t('38,400.00 KGS', 420, 260); t('52.800 CBM', 495, 260);
  t('Container / Seal / Packages / Weight / Volume', 160, 320, { bold: true });
  t('MSKU7781235 / 40HC / SEAL ML-4410921 / 20 PALLETS / 19,250.00 KGS / 26.400 CBM', 160, 332);
  t('MRKU4450123 / 40HC / SEAL ML-4410922 / 20 PALLETS / 19,150.00 KGS / 26.400 CBM', 160, 344);
  t('SHIPPED ON BOARD 02-AUG-2025', 35, 380); t('FREIGHT PREPAID', 300, 380);
  t('Synthetic document for OCR/IDP testing. Fictional parties and numbers.', 35, 820, { size: 6 });
});
await writeFile(path.join(here, 'docs/SYN2/BL_GSLU-JEA-77120_synthetic.pdf'), bl);
console.log('written');
