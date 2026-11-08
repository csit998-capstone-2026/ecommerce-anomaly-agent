import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFixture } from '../src/data/fixtures.ts';

export async function exportExample() {
  const fixture = makeFixture('stockout', 0);
  const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');
  await mkdir(output, { recursive: true });
  const filename = path.join(output, 'synthetic-stockout.json');
  await writeFile(filename, `${JSON.stringify({
    provenance: 'synthetic-example',
    synthetic: true,
    diagnosisCase: fixture.diagnosisCase,
    observations: fixture.observations,
  }, null, 2)}\n`);
  return filename;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.stdout.write(`${await exportExample()}\n`);
}
