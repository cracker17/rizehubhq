// Builds dist-preview/: index.html + office.js + office.css (DEMO data, no server). Needs `next build` first for CSS.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
const app = path.resolve(here, '..');
const out = path.join(app, 'dist-preview');
fs.mkdirSync(out, { recursive: true });
const src = path.join(app, 'src');
await build({
  entryPoints: [path.join(here, 'office-preview.tsx')],
  bundle: true, minify: true, format: 'iife', target: 'es2020', jsx: 'automatic',
  outfile: path.join(out, 'office.js'),
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_OFFICE_ASSETS': '"./office"' },
  alias: {
    'next/link': path.join(here, 'shims/next-link.tsx'),
    'next/dynamic': path.join(here, 'shims/next-dynamic.tsx'),
    '@/app/actions': path.join(here, 'shims/actions.ts'),
    '@/lib/supabase/browser': path.join(here, 'shims/supabase-browser.ts'),
    '@': src,
  },
  logLevel: 'warning',
});
const cssDir = path.join(app, '.next/static/css');
const css = fs.readdirSync(cssDir).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(cssDir, f), 'utf8')).join('\n');
fs.writeFileSync(path.join(out, 'office.css'), css);
fs.mkdirSync(path.join(out, 'office'), { recursive: true });
for (const f of ['office-bg.webp', 'manifest.json']) fs.copyFileSync(path.join(app, 'public/office', f), path.join(out, 'office', f));
fs.mkdirSync(path.join(out, 'office'), { recursive: true });
for (const f of ['office-bg.webp', 'manifest.json']) fs.copyFileSync(path.join(app, 'public/office', f), path.join(out, 'office', f));
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RizeHub HQ Office</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="office.css">
<style>html,body{background:#0b0a1f;margin:0}</style>
</head><body><div id="root"></div><script src="office.js"></script></body></html>`);
console.log('preview built:', fs.readdirSync(out).map((f) => `${f} ${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)} KB`).join(', '));
