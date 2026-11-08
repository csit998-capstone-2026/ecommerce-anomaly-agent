import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBusinessDataset, createJsonReadOnlyTools } from './data/json-tools.ts';
import { diagnoseWithTools } from './agent/diagnose.ts';

export async function diagnoseJsonFile(filename: string) {
  const dataset = await loadBusinessDataset(filename);
  return diagnoseWithTools(dataset.diagnosisCase, createJsonReadOnlyTools(dataset), {
    provenance: dataset.provenance ?? `unverified-local-json:${path.basename(filename)}`,
    synthetic: dataset.synthetic,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const filename = process.argv[2];
  if (!filename) {
    process.stderr.write('Usage: node src/cli.ts <diagnosis-data.json>\n');
    process.exitCode = 2;
  } else {
    try {
      const result = await diagnoseJsonFile(path.resolve(filename));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
