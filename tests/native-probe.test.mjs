// A failed native probe is reported as a located failure the differential can
// record for its trace (conformance/differential.mjs) rather than stop the run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { probeFailureReason, runProbe } from '../conformance/harness/native.mjs';

async function fakeProbe(body) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runic-probe-'));
  const binary = path.join(directory, 'runic-app');
  await writeFile(binary, `#!${process.execPath}\n${body}\n`);
  await chmod(binary, 0o755);
  return { binary, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('a panicking probe fails with its exit status and panic message', async () => {
  const { binary, cleanup } = await fakeProbe(
    [
      'process.stderr.write("\\nthread \'main\' (1) panicked at src/resolve.rs:492:21:\\n");',
      "process.stderr.write('layout child NodeId(47v1) of NodeId(34v1) is not in the slab\\n');",
      'process.exit(101);',
    ].join('\n'),
  );
  try {
    let failure;
    try {
      runProbe(binary, { actions: [{ kind: 'click', nth: 0 }] });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, 'E_NATIVE_PROBE');
    assert.equal(failure.status, 101);
    assert.match(failure.stderr, /not in the slab/);
    assert.equal(
      probeFailureReason(failure),
      'exit 101, panicked at src/resolve.rs:492:21: layout child NodeId(47v1) of NodeId(34v1) is not in the slab',
    );
  } finally {
    await cleanup();
  }
});

test('a probe failure without a panic reports its last stderr line', async () => {
  const { binary, cleanup } = await fakeProbe(
    "process.stderr.write('first\\nsecond line\\n\\n'); process.exit(3);",
  );
  try {
    assert.throws(
      () => runProbe(binary),
      error =>
        error.code === 'E_NATIVE_PROBE' && probeFailureReason(error) === 'exit 3: second line',
    );
  } finally {
    await cleanup();
  }
});
