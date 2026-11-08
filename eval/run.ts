import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeCorpus } from '../src/data/fixtures.ts';
import { evaluateModules123 } from './modules-1-3.ts';
import { evaluateRanking, evaluateVerification } from './modules-4-5.ts';
import { evaluateStress } from './stress.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sourceDigest(): Promise<string> {
  const files = [
    'src/domain/contracts.ts', 'src/domain/validation.ts', 'src/data/fixtures.ts',
    'src/algorithms/scheduler.ts', 'src/algorithms/context-budget.ts',
    'src/algorithms/tool-gate.ts', 'src/algorithms/ranking.ts',
    'src/algorithms/verification.ts', 'src/agent/task-executor.ts', 'src/agent/diagnose.ts',
    'eval/modules-1-3.ts', 'eval/modules-4-5.ts', 'eval/stress.ts',
  ];
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update(await readFile(path.join(ROOT, file)));
  }
  return hash.digest('hex');
}

function csv(value: unknown): string {
  const text = Array.isArray(value) ? value.join('|') : String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

export async function runEvaluation(writeResults = true) {
  const modules123 = await evaluateModules123();
  const ranking = evaluateRanking();
  const verification = await evaluateVerification();
  const modules = [...modules123, ranking, verification];
  const stress = await evaluateStress();
  const corpus = makeCorpus();
  const rows = verification.details?.cases as Array<Record<string, unknown>> | undefined ?? [];
  const result = {
    provenance: 'synthetic-holdout',
    synthetic: true,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      sourceSha256: await sourceDigest(),
      randomSeed: 20261023,
    },
    dataset: {
      total: corpus.length,
      development: corpus.filter(item => item.split === 'development').length,
      holdout: corpus.filter(item => item.split === 'holdout').length,
      scope: 'one synthetic store, one SKU per case, previous 7 days vs following 7 days',
      limits: [
        'All business observations are synthetic; this run does not establish field performance.',
        'The fixture generator and algorithms share the same project and cannot be treated as an independent external benchmark.',
        'Token results in module 2 use heuristic estimates, not a model tokenizer.',
        'Ranking scores are not calibrated causal probabilities.',
      ],
    },
    modules,
    stress,
    cases: rows,
  };
  if (writeResults) {
    const output = path.join(ROOT, 'eval', 'results');
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
    const columns = ['caseId', 'skuId', 'scenario', 'gold', 'baselineCause', 'fixedCause', 'fullCause',
      'fullStatus', 'baselineCorrect', 'fixedCorrect', 'fullCorrect', 'baselineUnsafe',
      'fullUnsafe', 'fixedQueries', 'fullQueries'];
    await writeFile(path.join(output, 'case-results.csv'), [
      columns.join(','),
      ...rows.map(row => columns.map(column => csv(row[column])).join(',')),
      '',
    ].join('\n'));
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await runEvaluation(true);
  process.stdout.write(`Wrote ${result.modules.length} module experiments on ${result.dataset.holdout} holdout cases.\n`);
  for (const module of result.modules) {
    process.stdout.write(`${module.name}: ${module.metrics.map(item =>
      `${item.name} ${item.baseline} → ${item.full} ${item.unit}`).join('; ')}\n`);
  }
}
