import { defineConfig } from 'vite';

export default defineConfig({
  base: '/framex-cloud/',
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
