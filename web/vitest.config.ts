import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

// Tests run without the IWSDK dev plugin: no emulator, no managed browser. The project options that plugin
// serves as a virtual module are an empty object here.
const iwsdkProject = {
  name: 'iwsdk-project-for-tests',
  resolveId: (id: string) => (id === 'virtual:iwsdk-project' ? '\0iwsdk-project' : null),
  load: (id: string) => (id === '\0iwsdk-project' ? 'export default {};' : null),
};

export default defineConfig({
  plugins: [preact(), iwsdkProject],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
