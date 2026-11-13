import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

// Tests run without the IWSDK dev plugin: no emulator, no managed browser.
export default defineConfig({
  plugins: [preact()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
