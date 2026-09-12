import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/* One identifier per deploy, so the service worker's shell cache rolls over and
   a phone can never keep serving a previous build. CI passes the commit sha. */
const build = `${pkg.version}-${process.env.FRAMEX_BUILD_ID || 'dev'}`;

export default defineConfig({
  base: './',
  define: {
    __FRAMEX_BUILD__: JSON.stringify(build),
    __FRAMEX_ENGINE__: JSON.stringify(pkg.dependencies['@ffmpeg/core'])
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
