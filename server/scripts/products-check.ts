/**
 * Render every product from the sample inputs and check the print layout.
 *
 *   node server/scripts/products-check.ts [out-dir] [--shots dir] [--browser]
 *
 * Writes one HTML file per product (plus GeoJSON, KML and CAP XML). With
 * --browser and playwright-core available (GD_PLAYWRIGHT_CORE, GD_CHROMIUM),
 * opens each in headless Chromium, fails if any sheet's content overflows its
 * page, prints each to Letter PDF and compares the PDF page count with the
 * "page X of Y" the layout printed, and with --shots saves JPEG screenshots.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { openDb } from '../src/db.ts';
import { createApp, platformOf } from '../src/index.ts';
import { testConfig } from '../src/platform/config.ts';
import { renderProduct } from '../src/products/index.ts';
import { SAMPLE_201, SAMPLE_214, SAMPLE_AAR, SAMPLE_ANNEX, SAMPLE_CAP, SAMPLE_EAP, SAMPLE_GEO, SAMPLE_META, SAMPLE_SECTIONS, SAMPLE_SITREP } from '../src/products/samples.ts';
import type { ProductKind } from '../src/types.ts';

const args = process.argv.slice(2);
const outDir = resolve(args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--shots') ?? 'data/products-check');
const shotsAt = args.indexOf('--shots');
const shotsDir = shotsAt >= 0 ? resolve(args[shotsAt + 1]!) : null;
const useBrowser = args.includes('--browser') || Boolean(shotsDir);
mkdirSync(outDir, { recursive: true });

const platform = platformOf(createApp(openDb(':memory:'), { config: testConfig() }));
const map = platform.maps('ohio-stadium') ?? platform.maps('default');
const ctx = { map, demo: false, now: Date.parse('2026-10-31T14:05:00-04:00'), capSender: 'sample-agency.example.gov' };
const geo = { ...SAMPLE_GEO, mapId: map?.id ?? 'test-3gate', zones: map?.places.filter((p) => p.kind === 'parking').slice(0, 2).map((p) => ({ id: p.id, placeId: p.id })) ?? [], closures: map?.closables.slice(0, 3).map((c) => ({ id: `close-${c.id}`, closableId: c.id, status: 'planned' as const })) ?? [], posts: map?.places.filter((p) => p.kind === 'gate').slice(0, 4).map((g, i) => ({ id: `post-${i}`, unit: `Unit ${10 + i} (sample)`, cell: g.cells[0]! })) ?? [], markers: map ? [{ id: 'm1', kind: 'medical' as const, name: 'Aid station 1', cell: map.places.find((p) => p.kind === 'concourse')?.cells[0] ?? 0, radiusCells: 15 }] : [] };

const jobs: [string, ProductKind, unknown, string?][] = [
  ['eap', 'eap', { ...SAMPLE_EAP, map: geo }],
  ['ics201', 'ics201', { ...SAMPLE_201, map: geo }],
  ['ics202', 'ics202', { meta: SAMPLE_META, sections: SAMPLE_SECTIONS }],
  ['ics203', 'ics203', { meta: SAMPLE_META, organization: SAMPLE_SECTIONS.organization }],
  ['ics204', 'ics204', { meta: SAMPLE_META, assignments: SAMPLE_SECTIONS.assignments }],
  ['ics205', 'ics205', { meta: SAMPLE_META, radio: SAMPLE_SECTIONS.radio }],
  ['ics205-empty', 'ics205', { meta: SAMPLE_META, radio: null }],
  ['ics206', 'ics206', { meta: SAMPLE_META, medical: SAMPLE_SECTIONS.medical }],
  ['ics208', 'ics208', { meta: SAMPLE_META, safety: SAMPLE_SECTIONS.safety }],
  ['ics214', 'ics214', SAMPLE_214],
  ['annex', 'annex', { meta: { ...SAMPLE_META, mode: 'simulation' }, annex: SAMPLE_ANNEX }],
  ['sitrep', 'sitrep', SAMPLE_SITREP],
  ['aar', 'aar', SAMPLE_AAR],
  ['cap', 'cap', SAMPLE_CAP, 'html'],
  ['cap-xml', 'cap', SAMPLE_CAP, 'xml'],
  ['features', 'geojson', geo],
  ['features-kml', 'kml', geo],
];

const files: { name: string; path: string; pages: number | null }[] = [];
for (const [name, kind, input, format] of jobs) {
  const out = renderProduct(kind, input, format, ctx);
  const ext = out.format === 'html' ? 'html' : out.format === 'geojson' ? 'geojson' : out.format;
  const path = join(outDir, `${name}.${ext}`);
  writeFileSync(path, out.body);
  files.push({ name, path, pages: out.pages });
  console.log(`${name}: ${out.format}${out.pages ? `, ${out.pages} page(s)` : ''}, ${(out.body.length / 1024).toFixed(1)} KB, ${out.classification}`);
}

if (useBrowser) {
  const core = process.env.GD_PLAYWRIGHT_CORE;
  if (!core) throw new Error('Set GD_PLAYWRIGHT_CORE (source /projects/sandbox/.kiro/env.sh) for --browser.');
  // playwright-core is a sandbox tool here, not a dependency: describe the little of it this script uses.
  type Sheet = { count(): Promise<number>; screenshot(o: object): Promise<unknown> };
  type Page = { goto(url: string): Promise<unknown>; evaluate<T>(fn: () => T): Promise<T>; pdf(o: object): Promise<Buffer>; locator(selector: string): { nth(n: number): Sheet } };
  type Browser = { newPage(o: object): Promise<Page>; close(): Promise<void> };
  const { chromium } = createRequire(import.meta.url)(join(core, 'index.js')) as { chromium: { launch(o: object): Promise<Browser> } };
  const browser = await chromium.launch({ executablePath: process.env.GD_CHROMIUM, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1100 }, deviceScaleFactor: 1 });
  let problems = 0;
  for (const f of files.filter((f) => f.path.endsWith('.html'))) {
    await page.goto(pathToFileURL(f.path).href);
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll('.sheet')].map((sheet, i) => {
        const body = sheet.querySelector('.body') as HTMLElement;
        return { page: i + 1, over: body.scrollHeight - body.clientHeight, width: body.scrollWidth - body.clientWidth };
      }).filter((s) => s.over > 1 || s.width > 1),
    );
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    const pdfPages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    const ok = !overflow.length && pdfPages === f.pages;
    if (!ok) problems++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${f.name}: layout ${f.pages} page(s), PDF ${pdfPages}${overflow.length ? `, overflow ${JSON.stringify(overflow)}` : ''}`);
  }
  if (shotsDir) {
    mkdirSync(shotsDir, { recursive: true });
    const shots: [string, string, number][] = [
      ['eap', 'ws3-eap-cover', 1],
      ['eap', 'ws3-ics202', 2],
      ['eap', 'ws3-ics204', 4],
      ['eap', 'ws3-ics205-radio', 5],
      ['eap', 'ws3-map', 8],
      ['eap', 'ws3-simulation-annex', 9],
      ['sitrep', 'ws3-sitrep', 1],
      ['aar', 'ws3-aar-ip', 2],
    ];
    for (const [name, shot, n] of shots) {
      const f = files.find((x) => x.name === name)!;
      await page.goto(pathToFileURL(f.path).href);
      const sheet = page.locator('.sheet').nth(n - 1);
      if ((await sheet.count()) === 0) continue;
      await sheet.screenshot({ path: join(shotsDir, `${shot}.jpg`), type: 'jpeg', quality: 82 });
      console.log(`shot ${shot}.jpg (${name} page ${n})`);
    }
  }
  await browser.close();
  if (problems) {
    console.error(`${problems} product(s) failed the print check`);
    process.exit(1);
  }
}
