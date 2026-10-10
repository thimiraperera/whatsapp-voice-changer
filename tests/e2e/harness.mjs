import { launch, openPage, sleep } from './cdp.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const b = await launch({ headless: true, extraArgs: ['--allow-file-access-from-files'] });
try {
  const p = await openPage(b, pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine-harness.html')).href);
  let r = null;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    r = await p.evaluate('window.__WVC_TEST_RESULTS || null');
    if (r && r.done) break;
  }
  if (!r) { console.log('no results', p.logs.slice(0, 20)); }
  else {
    console.log('pass:', r.pass, 'cases:', r.cases.length);
    for (const c of r.cases) {
      const bad = c.pass === false;
      console.log(`${bad ? 'FAIL' : 'ok  '} ${String(c.name || c.id).padEnd(34)} proc=${c.processorType} lat=${c.latency != null ? (c.latency * 1000).toFixed(1) + 'ms' : '-'} peak=${c.peak != null ? c.peak.toFixed(3) : '-'} rms=${c.rmsDb != null ? c.rmsDb.toFixed(1) : '-'} f0=${c.f0 != null ? c.f0.toFixed(1) : '-'} nan=${c.nanCount ?? c.nan ?? '-'} ${c.errors && c.errors.length ? 'ERR ' + JSON.stringify(c.errors) : ''} ${bad && c.reasons ? JSON.stringify(c.reasons) : ''}`);
    }
    const errs = p.logs.filter((l) => /error|exception/i.test(l));
    if (errs.length) console.log('console:', errs.slice(0, 10));
  }
} catch (e) { console.error(e); } finally { await b.close(); }
