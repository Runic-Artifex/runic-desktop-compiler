import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { lower } from './frontend.mjs';
import { hash, Diagnostic } from './collect.mjs';
import { repository, validateRule } from './mappings.mjs';

export async function discover(
  graph,
  out,
  {
    replay = false,
    provider,
    codex = false,
    model = 'gpt-6-sol',
    feedback = null,
    constraints = null,
    registry = true,
  } = {},
) {
  let failure;
  try {
    await lower(graph, { registry: codex && registry });
  } catch (error) {
    failure = error;
  }
  if (failure?.code !== 'E_MAPPING' || !failure.discovery)
    throw new Diagnostic('E_DISCOVERY', 'Discovery requires an unsupported local pure helper');
  const schema = await readFile(path.join(repository, 'mappings/schema.json'), 'utf8');
  const bundle = {
    schema: 2,
    instruction:
      'Propose a restricted reusable mapping. Inspect the helper implementation. No application names, paths, executable extensions, or certifications. Return mapping JSON only. Use schema 2, a positive integer version, and all required fields including preconditions.evaluation. Preserve the exact matcher implementation and its executed integer intermediate bounds. Use provenance mode live, provider OpenAI Codex CLI, model ' +
      model +
      ', liveDiscovery true. An identical expression lowering is valid.',
    inputHash: graph.hash,
    diagnostic: failure.toJSON(),
    ...failure.discovery,
    mappingSchema: JSON.parse(schema),
  };
  if (feedback) bundle.validationFeedback = feedback;
  if (constraints) bundle.reusableConstraints = constraints;
  const input = JSON.stringify(bundle, null, 2) + '\n';
  if (Buffer.byteLength(input) > 65536)
    throw new Diagnostic('E_DISCOVERY_SIZE', 'Discovery bundle exceeds 64 KiB');
  await mkdir(out, { recursive: true });
  try {
    await writeFile(path.join(out, 'bundle.json'), input, { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST')
      throw new Diagnostic(
        'E_DISCOVERY_OUTPUT',
        'Discovery output already contains an attempt; choose a new directory',
      );
    throw e;
  }
  let bytes, identity;
  if (replay) {
    bytes = await readFile(path.join(repository, 'mappings/replay/pure-clamp.json'), 'utf8');
    identity = {
      mode: 'replay',
      provider: 'compiler-owned-fixture',
      model: null,
      liveDiscovery: false,
    };
  } else if (codex) {
    const work = await mkdtemp(path.join(os.tmpdir(), 'runic-discovery-'));
    const started = new Date().toISOString();
    try {
      const invocation = await new Promise((resolve, reject) => {
        const args = [
          'exec',
          '--ignore-user-config',
          '--ephemeral',
          '--skip-git-repo-check',
          '--disable',
          'shell_tool',
          '-s',
          'read-only',
          '-C',
          work,
          '-m',
          model,
          '--json',
          '--color',
          'never',
          '-',
        ];
        const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '',
          stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
        child.stdout.on('data', b => {
          output += b;
          if (output.length > 1024 * 1024) child.kill('SIGKILL');
        });
        child.stderr.on('data', b => {
          stderr += b;
          if (stderr.length > 1024 * 1024) child.kill('SIGKILL');
        });
        child.on('error', e => {
          clearTimeout(timer);
          reject(e);
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, output, stderr });
        });
        child.stdin.end(input);
      });
      const events = invocation.output
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
      // Retain only safe provider receipts and final text. Tool execution invalidates discovery.
      const items = events.filter(e => e.type === 'item.completed').map(e => e.item);
      const forbidden = items.filter(i => !['agent_message', 'reasoning'].includes(i.type));
      const receipt = {
        schema: 2,
        mode: 'live',
        provider: 'OpenAI Codex CLI',
        model,
        modelSelection: 'Explicitly selected existing user-configured model',
        started,
        ended: new Date().toISOString(),
        exitCode: invocation.code,
        signal: invocation.signal,
        threadId: events.find(e => e.type === 'thread.started')?.thread_id ?? null,
        usage: events.find(e => e.type === 'turn.completed')?.usage ?? null,
        eventTypes: events.map(e => e.type),
        toolItems: forbidden.map(i => i.type),
        inputHash: hash(input),
        isolatedWorkingDirectory: true,
        shellToolDisabled: true,
        userConfigIgnored: true,
      };
      await writeFile(path.join(out, 'invocation.json'), JSON.stringify(receipt, null, 2) + '\n');
      if (invocation.code !== 0 || forbidden.length)
        throw new Diagnostic(
          'E_PROVIDER',
          'Live provider failed or attempted tool use; see retained invocation receipt',
        );
      bytes = items.filter(i => i.type === 'agent_message').at(-1)?.text;
      if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > 65536)
        throw new Diagnostic('E_PROVIDER', 'Live provider did not return bounded final JSON');
      identity = {
        mode: 'live',
        provider: receipt.provider,
        model,
        liveDiscovery: true,
        threadId: receipt.threadId,
        usage: receipt.usage,
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  } else if (provider) {
    // Explicit command boundary: executable reads bounded JSON stdin, emits JSON stdout.
    // No shell interpolation, credentials, or stderr are retained in evidence.
    bytes = await new Promise((resolve, reject) => {
      const child = spawn(provider, [], { stdio: ['pipe', 'pipe', 'ignore'] });
      let output = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Diagnostic('E_PROVIDER', 'Provider timed out after 60 seconds'));
      }, 60000);
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.length > 65536) {
          child.kill();
          reject(new Diagnostic('E_PROVIDER', 'Provider output exceeds 64 KiB'));
        }
      });
      child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timer);
        code === 0
          ? resolve(output)
          : reject(new Diagnostic('E_PROVIDER', `Provider exited ${code}`));
      });
      child.stdin.end(input);
    });
    identity = {
      mode: 'external-provider-command',
      provider: path.basename(provider),
      model: process.env.RUNIC_MODEL_ID ?? null,
      liveDiscovery: false,
      liveProviderUnvalidated: true,
    };
  } else
    throw new Diagnostic(
      'E_PROVIDER',
      'No authorized model interface configured. Pass --replay for a labeled provider-boundary experiment, or --provider /absolute/executable',
    );
  // Preserve model content and record invocation identity separately; no claim is certified here.
  await writeFile(path.join(out, 'candidate.json'), bytes);
  const candidate = validateRule(JSON.parse(bytes));
  const provenance = {
    schema: 2,
    ...identity,
    promptHash: hash(bundle.instruction),
    inputHash: hash(input),
    applicationSourceHash: graph.hash,
    candidateHash: hash(bytes),
    heldOutSourceIncluded: false,
    candidateProvenance: candidate.provenance,
  };
  await writeFile(path.join(out, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  return provenance;
}
