import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'Freight Doc Extractor', description: 'CPU-only OCR + field extraction for shipping documents' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
