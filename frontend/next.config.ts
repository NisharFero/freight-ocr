import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Native / WASM / large-data packages must stay external (loaded from node_modules at runtime, never bundled).
  serverExternalPackages: [
    'onnxruntime-node',
    'sharp', '@napi-rs/canvas', 'tesseract.js', 'unpdf', 'an-array-of-english-words', '@nwpr/airport-codes',
    'i18n-iso-countries', 'currency-codes',
  ],
};
export default nextConfig;
