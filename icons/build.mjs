// Regenerates icons/icon*.png from wren-mark.js using headless Chrome: node icons/build.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const page = pathToFileURL(fileURLToPath(new URL('build.html', import.meta.url))).href;
const dom = execFileSync(CHROME, ['--headless=new', '--allow-file-access-from-files', '--dump-dom', page], { encoding: 'utf8' });
const json = dom.match(/<pre id="out">(.*?)<\/pre>/s)[1].replace(/&quot;/g, '"');
for (const [size, url] of Object.entries(JSON.parse(json))) {
  writeFileSync(new URL(`icon${size}.png`, import.meta.url), Buffer.from(url.split(',')[1], 'base64'));
  console.log(`icon${size}.png`);
}
