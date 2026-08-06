import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/polar.ts',
    'src/lemon-squeezy.ts',
    'src/stripe.ts',
    'src/paddle.ts',
    'src/dodo-payments.ts',
    'src/testing.ts',
  ],
  format: 'esm',
  platform: 'neutral',
  dts: true,
});
