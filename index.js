/**
 * Teamwork for DeepSeek Harness — Host plugin.
 *
 * Ported from https://github.com/1535273240sch-droid/zcode-teamwork (MIT).
 * The vendored `vendor/teamwork` tree is the original plugin, byte-for-byte, so
 * its hooks, engine, CLI and role roster keep their own semantics. This file is
 * only the Harness adapter:
 *
 *   ZCode hook            ->  Harness seam
 *   SessionStart          ->  system-prompt/assemble context (cached from the hook)
 *   UserPromptSubmit      ->  agent/pre-step (step 1 of a user turn)
 *   PreToolUse Write|Edit ->  tools/pre-execute (write, edit)
 *   PreToolUse Bash       ->  tools/pre-execute (pwsh, bash)
 *   PreToolUse Task|Agent ->  tools/pre-execute (subagent, subagent_fork, spawn_teammate)
 *   PostToolUse           ->  tools/post-execute (audit trail + captured evidence)
 *   Stop                  ->  agent/turn-stopping (steers once; the hook's own
 *                             stop_hook_active contract prevents a loop)
 *
 * Plus: the campaign engine as a `teamwork` tool, `/teamwork*` slash commands,
 * the two skills, the eleven role prompts, and a resident watchdog that heals
 * expired leases / abandoned dispatch reservations.
 *
 * Only Node built-ins are imported, so the bundle resolves with no dependencies.
 *
 * @module dsh-teamwork
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { liveState } from './live.js';

export const name = 'teamwork';
export const inject = ['tools', 'systemPrompt'];

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(PKG_DIR, 'vendor', 'teamwork');
const HOOKS_DIR = join(VENDOR_DIR, 'hooks');
const LIB_DIR = join(VENDOR_DIR, 'lib');
const AGENTS_DIR = join(VENDOR_DIR, 'agents');
const SKILLS_DIR = join(VENDOR_DIR, 'skills');
const CLI_PATH = join(LIB_DIR, 'teamwork-cli.mjs');

const ACTIVE_PHASES = ['approved', 'executing', 'verifying'];
const DEFAULT_HOOK_TIMEOUT_MS = 6000;
const WATCHDOG_INTERVAL_MS = 5 * 60_000;
const CHARTER_TTL_MS = 30_000;
const SUMMARY_MAX = 120;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** One immutable user-role notice, shaped like the Harness's own notices. */
function userNote(text, summary) {
  const trimmed = String(summary ?? 'Teamwork');
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: {
      kind: 'teamwork',
      form: 'notice',
      summary: trimmed.length <= SUMMARY_MAX ? trimmed : `${trimmed.slice(0, SUMMARY_MAX - 1)}…`,
    },
  };
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * ZCode's process-hook payloads arrive in two spellings depending on the runtime
 * generation: Claude-Code snake_case and ZCode camelCase. The scripts read both
 * with `pick(camel ?? snake)`, so emit both keys for every field.
 */
function hookPayload(fields) {
  const payload = {};
  const aliases = {
    hook_event_name: 'hookEventName',
    session_id: 'sessionId',
    transcript_path: 'transcriptPath',
    agent_id: 'agentId',
    tool_name: 'toolName',
    tool_input: 'toolInput',
    tool_use_id: 'toolUseId',
    tool_response: 'toolResponse',
    tool_response_is_error: 'toolResponseIsError',
    stop_hook_active: 'stopHookActive',
  };
  for (const [key, value] of Object.entries(fields)) {
    payload[key] = value;
    const alias = aliases[key];
    if (alias) payload[alias] = value;
  }
  return payload;
}

/**
 * Translate the PowerShell write forms a Worker is likely to use into the POSIX
 * forms `bash-guard.mjs` recognises, so the shell guard keeps working on a
 * Windows Harness instead of silently covering nothing. The original command is
 * appended verbatim as well: the hook de-duplicates targets and still applies
 * its own conservative rules.
 */
function translateShellWrites(command) {
  if (typeof command !== 'string' || command.length === 0) return command;
  const translated = [];
  const target = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)`;
  const add = (text) => {
    if (typeof text === 'string' && text.length > 0) translated.push(text);
  };
  const cmdlet = (name, posix) => {
    const re = new RegExp(String.raw`\b${name}\b((?:\s+-[A-Za-z]\S*(?:\s+${target})?)*)`, 'gi');
    let match;
    while ((match = re.exec(command)) !== null) {
      const tail = match[1] ?? '';
      const named = new RegExp(String.raw`-(?:LiteralPath|FilePath|Path)\s+${target}`, 'i').exec(tail);
      if (named) add(`${posix} ${named[1]}`);
    }
  };
  cmdlet('Set-Content', 'tee');
  cmdlet('Add-Content', 'tee');
  cmdlet('Out-File', 'tee');
  cmdlet('Clear-Content', 'truncate');
  cmdlet('Remove-Item', 'rm');
  cmdlet('New-Item', 'truncate');
  cmdlet('Tee-Object', 'tee');
  // Destination is the second positional path for these.
  for (const name of ['Copy-Item', 'Move-Item', 'Rename-Item']) {
    const re = new RegExp(String.raw`\b${name}\b\s+${target}\s+${target}`, 'gi');
    let match;
    while ((match = re.exec(command)) !== null) add(`${name === 'Copy-Item' ? 'cp' : 'mv'} ${match[1]} ${match[2]}`);
    const named = new RegExp(String.raw`\b${name}\b[^\n;&|]*-Destination\s+${target}`, 'gi');
    while ((match = named.exec(command)) !== null) add(`${name === 'Copy-Item' ? 'cp' : 'mv'} ${target} ${match[1]}`);
  }
  // .NET file APIs and native redirection.
  let dotnet;
  const dotnetRe = /::(?:WriteAllText|WriteAllLines|AppendAllText|AppendAllLines|Delete)\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi;
  while ((dotnet = dotnetRe.exec(command)) !== null) add(`tee ${dotnet[1]}`);
  const redirection = /(?:^|[\s;])(?:[0-9]?>>?)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g;
  let redirect;
  while ((redirect = redirection.exec(command)) !== null) add(`tee ${redirect[1]}`);
  if (translated.length === 0) return command;
  return `${command}\n${translated.join('\n')}`;
}

function readJson(path) {
  try {
    return JSON.parse(stripBom(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

function campaignState(cwd) {
  const value = readJson(join(cwd, '.teamwork', 'campaign.json'));
  return value && typeof value === 'object' ? value : undefined;
}

function isActiveCampaign(campaign) {
  return Boolean(campaign) && campaign.approved === true && ACTIVE_PHASES.includes(String(campaign.phase));
}

function sessionCwd(ctx, agent) {
  try {
    const session = agent?.session;
    if (session !== undefined) {
      const dir = ctx.get('workingDirectory')?.get?.(session);
      if (typeof dir === 'string' && dir.length > 0) return dir;
      if (typeof session?.header?.cwd === 'string' && session.header.cwd.length > 0) return session.header.cwd;
    }
  } catch {
    // fall through
  }
  return process.cwd();
}

function textOfResult(result) {
  try {
    const blocks = Array.isArray(result?.content) ? result.content : [];
    const text = blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    if (text.length > 0) return text;
    if (result?.value !== undefined) return JSON.stringify(result.value);
  } catch {
    // ignore
  }
  return '';
}

function exitCodeOfResult(result) {
  const value = result?.value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const n = Number(value.exitCode ?? value.exit_code ?? value.code);
    if (Number.isFinite(n)) return n;
  }
  const meta = Number(result?.meta?.exitCode);
  return Number.isFinite(meta) ? meta : undefined;
}

function normalizeFileArgs(args) {
  const input = args && typeof args === 'object' ? args : {};
  const filePath = input.file_path ?? input.filePath ?? input.absolute_path ?? input.path;
  return typeof filePath === 'string' && filePath.length > 0 ? { ...input, file_path: filePath } : { ...input };
}

const DISPATCH_TOOLS = new Set(['subagent', 'subagent_fork', 'spawn_teammate']);

/**
 * Map one Harness tool call onto the ZCode tool vocabulary the hooks were
 * written against. `kind` selects which pre-tool hook applies.
 */
function mapToolCall(toolName, args) {
  if (toolName === 'write') return { zcode: 'Write', args: normalizeFileArgs(args), kind: 'file' };
  if (toolName === 'edit') return { zcode: 'Edit', args: normalizeFileArgs(args), kind: 'file' };
  if (toolName === 'read') return { zcode: 'Read', args: normalizeFileArgs(args), kind: 'read' };
  if (toolName === 'pwsh' || toolName === 'bash') {
    const input = args && typeof args === 'object' ? args : {};
    return {
      zcode: 'Bash',
      args: { ...input, command: input.command ?? input.script ?? input.cmd ?? '' },
      kind: 'bash',
    };
  }
  if (DISPATCH_TOOLS.has(toolName)) {
    const input = args && typeof args === 'object' ? args : {};
    return {
      zcode: 'Agent',
      args: {
        ...input,
        subagent_type: input.subagent_type ?? input.subagentType ?? input.name ?? input.description ?? 'subagent',
        description: input.description,
        prompt: input.prompt,
      },
      kind: 'dispatch',
    };
  }
  return { zcode: toolName, args: args ?? {}, kind: 'other' };
}

// ---------------------------------------------------------------------------
// Hook execution
// ---------------------------------------------------------------------------

/** Resolve a Node executable that can run the vendored hook scripts. */
function nodeCommand() {
  if (process.env.DSH_DESKTOP_NODE_EXECUTABLE) return process.env.DSH_DESKTOP_NODE_EXECUTABLE;
  if (process.versions?.electron) return process.execPath;
  return process.env.ComSpec ? 'node' : 'node';
}

const NODE_COMMAND = nodeCommand();

function runHook(script, payload, cwd, timeoutMs = DEFAULT_HOOK_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    let child;
    try {
      child = spawn(NODE_COMMAND, [join(HOOKS_DIR, script)], {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          // Electron main is not Node; ELECTRON_RUN_AS_NODE makes execPath behave
          // like the bundled node runtime the desktop ships.
          ...(process.versions?.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          ZCODE_PROJECT_DIR: cwd,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ output: undefined, error });
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk;
      else truncated = true;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 200_000) stderr += chunk;
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish({ output: undefined, error: new Error(`hook ${script} timed out after ${timeoutMs}ms`) });
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ output: undefined, error });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const raw = stdout.trim();
      if (raw.length === 0) {
        finish({ output: undefined, code, stderr, truncated });
        return;
      }
      try {
        finish({ output: JSON.parse(raw), code, stderr, truncated });
      } catch (error) {
        finish({ output: undefined, code, stderr: stderr || raw, parseError: error, truncated });
      }
    });

    try {
      child.stdin?.end(JSON.stringify(payload));
    } catch (error) {
      finish({ output: undefined, error });
    }
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx) {
  const logger = ctx.logger;
  const warn = (message, error) => {
    try {
      logger?.warn?.(`teamwork: ${message}`, error);
    } catch {
      // logging must never break a tool call
    }
  };

  const charterCache = new Map(); // agent id -> { key, at, text }
  const pendingContexts = new Map(); // tool call id -> context text
  const blockedTurns = new Map(); // agent id -> turn number already steered
  const engineCache = new Map(); // cwd -> engine instance
  let dashboardModule;
  let watchdogModule;
  let engineModule;
  let routerModule;

  async function loadLibModule(file) {
    return import(pathToFileURL(join(LIB_DIR, file)).href);
  }

  async function engineFor(cwd) {
    const key = resolve(cwd);
    const cached = engineCache.get(key);
    if (cached) return cached;
    engineModule ??= await loadLibModule('engine.mjs');
    const engine = new engineModule.TeamworkEngine({ cwd: key });
    engineCache.set(key, engine);
    return engine;
  }

  async function dashboardRenderer() {
    dashboardModule ??= await loadLibModule('dashboard.mjs');
    return dashboardModule.renderDashboard;
  }

  async function watchdog() {
    watchdogModule ??= await loadLibModule('watchdog.mjs');
    return watchdogModule;
  }

  async function recommendTier(objective, files = []) {
    routerModule ??= await loadLibModule('router.mjs');
    return routerModule.recommendTier({ objective, affectedFiles: files });
  }

  // -- SessionStart context -------------------------------------------------
  //
  // ZCode injects the campaign charter as SessionStart additionalContext. Here it
  // is a dynamic runtime-context entry: the provider is synchronous, so the hook's
  // text is refreshed ahead of assembly (agent/created, user prompts, campaign
  // mutations, watchdog ticks) and read from the cache per request. Recomputing a
  // prompt section inside system-prompt/assemble is explicitly discouraged by the
  // Harness plugin practices.

  async function refreshCharter(agent, { force = false } = {}) {
    if (!agent?.id) return '';
    const cwd = sessionCwd(ctx, agent);
    const campaignFile = join(cwd, '.teamwork', 'campaign.json');
    if (!existsSync(campaignFile)) {
      charterCache.delete(agent.id);
      return '';
    }
    let key = cwd;
    try {
      key += `|${statSync(campaignFile).mtimeMs}`;
    } catch {
      // keep cwd-only key
    }
    const hit = charterCache.get(agent.id);
    if (!force && hit && hit.key === key && Date.now() - hit.at < CHARTER_TTL_MS) return hit.text;
    const { output } = await runHook(
      'session-context.mjs',
      hookPayload({
        hook_event_name: 'SessionStart',
        session_id: String(agent.id),
        agent_id: String(agent.id),
        cwd,
      }),
      cwd,
    );
    const text = typeof output?.hookSpecificOutput?.additionalContext === 'string' ? output.hookSpecificOutput.additionalContext : '';
    charterCache.set(agent.id, { key, at: Date.now(), text });
    return text;
  }

  function cachedCharter(agent) {
    return agent?.id ? (charterCache.get(agent.id)?.text ?? '') : '';
  }

  async function refreshChartersForCwd(cwd) {
    const target = resolve(cwd);
    for (const agent of ctx.get('agents')?.list?.() ?? []) {
      try {
        if (resolve(sessionCwd(ctx, agent)) !== target) continue;
        await refreshCharter(agent, { force: true });
      } catch {
        // one stale cache must not break the mutation that asked for the refresh
      }
    }
  }

  ctx.systemPrompt.context({
    name: 'teamwork:charter',
    order: ctx.systemPrompt.getContextOrder('TEAM_IDENTITY') ?? 125,
    text: (context) => cachedCharter(context?.agent),
  });

  // -- SessionStart warm-up + tree state ------------------------------------

  ctx.on('agent/created', async ({ agent }) => {
    try {
      await refreshCharter(agent, { force: true });
      const cwd = sessionCwd(ctx, agent);
      const campaign = campaignState(cwd);
      if (isActiveCampaign(campaign)) {
        const wd = await watchdog();
        wd.healHealth?.({ cwd, stateDir: join(cwd, '.teamwork') });
      }
    } catch (error) {
      warn('session start failed', error);
    }
  });

  // -- UserPromptSubmit -> progress watch when a new user prompt enters ------

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      if (decision?.kind !== 'enter') return decision;
      const agent = payload?.agent;
      const cwd = sessionCwd(ctx, agent);
      const campaign = campaignState(cwd);
      if (!isActiveCampaign(campaign)) return decision;
      const messages = Array.isArray(decision.messages) ? decision.messages : [];
      const hasUserPrompt = messages.some((message) => message?.role === 'user' && message?.source?.kind === 'user');
      if (!hasUserPrompt) return decision;
      // A user turn is the natural refresh point for the injected charter: the
      // next assembly sees state written outside the teamwork tool.
      void refreshCharter(agent).catch(() => {});
      const promptText = messages
        .filter((message) => message?.role === 'user')
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .slice(0, 8000);
      const { output } = await runHook(
        'progress-watch.mjs',
        hookPayload({
          hook_event_name: 'UserPromptSubmit',
          session_id: String(agent?.id ?? 'unknown'),
          agent_id: String(agent?.id ?? 'unknown'),
          cwd,
          prompt: promptText,
        }),
        cwd,
      );
      const note = output?.hookSpecificOutput?.additionalContext;
      if (typeof note !== 'string' || note.length === 0) return decision;
      return { ...decision, messages: [...messages, userNote(note, 'Teamwork progress watch')] };
    } catch (error) {
      warn('progress watch failed', error);
      return decision;
    }
  });

  // -- PreToolUse hooks ------------------------------------------------------

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const agent = exec?.agent;
      const cwd = sessionCwd(ctx, agent);
      const campaign = campaignState(cwd);
      if (!isActiveCampaign(campaign)) return await next();
      const mapped = mapToolCall(exec.name, exec.arguments);
      const hook =
        mapped.kind === 'file'
          ? 'ownership-lock.mjs'
          : mapped.kind === 'bash'
            ? 'bash-guard.mjs'
            : mapped.kind === 'dispatch'
              ? 'spawn-budget.mjs'
              : undefined;
      if (hook === undefined) return await next();
      const toolInput =
        mapped.kind === 'bash'
          ? { ...mapped.args, command: translateShellWrites(mapped.args.command) }
          : mapped.args;
      const { output } = await runHook(
        hook,
        hookPayload({
          hook_event_name: 'PreToolUse',
          session_id: String(agent?.id ?? 'unknown'),
          agent_id: String(agent?.id ?? 'unknown'),
          cwd,
          tool_name: mapped.zcode,
          tool_input: toolInput,
          tool_use_id: String(exec.callId ?? ''),
        }),
        cwd,
      );
      const specific = output?.hookSpecificOutput;
      if (specific?.permissionDecision === 'deny') {
        return { kind: 'deny', reason: String(specific.permissionDecisionReason ?? 'blocked by the Teamwork ownership guard') };
      }
      if (specific?.permissionDecision === 'allow' && typeof specific.additionalContext === 'string' && specific.additionalContext.length > 0) {
        pendingContexts.set(String(exec.callId ?? ''), specific.additionalContext);
      }
    } catch (error) {
      warn('pre-tool ownership check failed', error);
    }
    return await next();
  });

  // -- PostToolUse -> audit trail, captured evidence, queued context --------

  ctx.on('tools/post-execute', async (exec, result, next) => {
    let note;
    try {
      note = pendingContexts.get(String(exec?.callId ?? ''));
      pendingContexts.delete(String(exec?.callId ?? ''));
      const agent = exec?.agent;
      const cwd = sessionCwd(ctx, agent);
      const campaign = campaignState(cwd);
      if (campaign) {
        const mapped = mapToolCall(exec.name, exec.arguments);
        await runHook(
          'audit-log.mjs',
          hookPayload({
            hook_event_name: 'PostToolUse',
            session_id: String(agent?.id ?? 'unknown'),
            agent_id: String(agent?.id ?? 'unknown'),
            cwd,
            tool_name: mapped.zcode,
            tool_input: mapped.args,
            tool_use_id: String(exec.callId ?? ''),
            tool_response: {
              output: textOfResult(result).slice(0, 20_000),
              exitCode: exitCodeOfResult(result),
              is_error: Boolean(result?.isError),
              status: result?.isError ? 'failed' : 'success',
            },
            tool_response_is_error: Boolean(result?.isError),
          }),
          cwd,
        );
      }
    } catch (error) {
      warn('audit trail failed', error);
    }
    try {
      // A charter written directly with write/edit must reach the injected context.
      if ((exec.name === 'write' || exec.name === 'edit') && exec.arguments && typeof exec.arguments === 'object') {
        const filePath = exec.arguments.file_path ?? exec.arguments.path;
        if (typeof filePath === 'string' && /[\\/]\.teamwork[\\/]campaign\.json$/i.test(filePath)) {
          await refreshChartersForCwd(sessionCwd(ctx, exec.agent));
        }
      }
      // A shell command that touches campaign state (including deleting it) can
      // change the injected charter too.
      if ((exec.name === 'pwsh' || exec.name === 'bash') && exec.arguments && typeof exec.arguments === 'object' && typeof exec.arguments.command === 'string' && exec.arguments.command.includes('.teamwork')) {
        await refreshChartersForCwd(sessionCwd(ctx, exec.agent));
      }
    } catch {
      // context refresh is best-effort
    }
    const decision = await next();
    if (typeof note === 'string' && note.length > 0) {
      return {
        ...decision,
        additionalContexts: [...(decision.additionalContexts ?? []), userNote(note, 'Teamwork ownership')],
      };
    }
    return decision;
  });

  // -- Stop -> verification gate, steered once per turn ---------------------

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    try {
      const cwd = sessionCwd(ctx, agent);
      const campaign = campaignState(cwd);
      if (!isActiveCampaign(campaign)) return;
      const key = String(agent?.id ?? 'unknown');
      const alreadySteered = blockedTurns.get(key) === turn;
      const { output } = await runHook(
        'verification-gate.mjs',
        hookPayload({
          hook_event_name: 'Stop',
          session_id: key,
          agent_id: key,
          cwd,
          stop_hook_active: alreadySteered,
        }),
        cwd,
      );
      if (output?.decision !== 'block' || typeof output.reason !== 'string' || output.reason.length === 0) return;
      if (alreadySteered) return;
      blockedTurns.set(key, turn);
      agent.steer(userNote(output.reason, 'Teamwork verification gate'));
    } catch (error) {
      warn('verification gate failed', error);
    }
  });

  // -- Campaign tool --------------------------------------------------------

  const ACTIONS = [
    'init',
    'approve',
    'advance',
    'cancel',
    'decompose',
    'plan',
    'schedule',
    'claim',
    'release',
    'can-write',
    'check',
    'verify',
    'final',
    'status',
    'dashboard',
    'stale',
    'handoff',
    'patterns',
    'pattern',
    'isolation',
    'briefing',
    'succession',
    'blackboard',
    'blackboard-post',
    'pitfalls',
    'record-pitfall',
    'synthesis',
    'role',
    'roles',
    'watchdog',
    'tier',
    'where',
  ];

  ctx.tools.register({
    name: 'teamwork',
    description:
      'Drive a Teamwork campaign in this workspace (ported from zcode-teamwork). Use `init` to create the charter, `approve` after the human approves, `plan` to record milestones and the exclusive file-ownership table, `verify`/`final` to record verdicts, and `status`/`dashboard` to report. Actions: ' +
      ACTIONS.join(', ') +
      '. `role` returns one of the eleven role prompts (sentinel, orchestrator, explorer, worker, test-writer, spec-miner, critic, challenger, empirical-challenger, auditor, success-auditor) to pass to a subagent. `tier` recommends L1/L2/L3. `where` reports the vendored engine, hooks and skills paths.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'Campaign operation to perform.' },
        objective: { type: 'string', description: 'Campaign objective (init, decompose, tier).' },
        mode: { type: 'string', description: 'init: quick | standard | strict | agile | ...' },
        integrity: { type: 'string', description: 'init: development | demo | benchmark.' },
        pattern: { type: 'string', description: 'init/pattern: orchestration pattern id.' },
        path: { type: 'string', description: 'init: explicit execution path.' },
        force: { type: 'boolean', description: 'init: replace an existing campaign.' },
        phase: { type: 'string', description: 'advance: target phase (executing, verifying, complete, aborted).' },
        reason: { type: 'string', description: 'cancel/handoff/briefing: reason text.' },
        milestone: { type: 'string', description: 'Milestone id (claim, release, can-write, check, verify).' },
        file: { type: 'string', description: 'Repository-relative or absolute file path.' },
        role: { type: 'string', description: 'claim: owner role; role action: role name.' },
        lease: { type: 'number', description: 'claim: lease minutes.' },
        affected: { type: 'number', description: 'check: affected file count.' },
        milestones: { description: 'plan: JSON array (or array) of milestone objects.' },
        verdicts: { description: 'verify/final: JSON array (or array) of verdict objects.' },
        task: { type: 'string', description: 'tier: task text.' },
        files: { type: 'string', description: 'tier: comma-separated affected files.' },
        set: { type: 'string', description: 'pattern: set a pattern id.' },
        suggest: { type: 'string', description: 'pattern: suggest for an objective (empty string uses the campaign objective).' },
        workstream: { type: 'string', description: 'isolation: workstream id.' },
        prepare: { type: 'string', description: 'isolation: prepare a worktree for a workstream id.' },
        update: { description: 'blackboard-post: update object or JSON string.' },
        filter: { description: 'blackboard/pitfalls: filter object or JSON string.' },
        entry: { description: 'record-pitfall: pitfall object or JSON string.' },
        heal: { type: 'boolean', description: 'watchdog: heal instead of only inspecting.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    timeoutMs: 120_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value?.text ?? '' }];
      },
    },
    async execute(args, exec) {
      const action = String(args?.action ?? '');
      const cwd = sessionCwd(ctx, exec.agent);
      try {
        const result = await runAction(action, args ?? {}, cwd);
        if (result.ok !== false && MUTATING_ACTIONS.has(action)) {
          // Keep the injected charter current for the next assembly.
          await refreshChartersForCwd(cwd);
        }
        return { ok: result.ok !== false, text: String(result.text ?? '') };
      } catch (error) {
        return { ok: false, text: `teamwork ${action} failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });

  const MUTATING_ACTIONS = new Set([
    'init',
    'approve',
    'advance',
    'cancel',
    'plan',
    'claim',
    'release',
    'verify',
    'final',
    'pattern',
    'isolation',
    'blackboard-post',
    'record-pitfall',
  ]);

  function parseJsonish(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length === 0) return fallback;
      return JSON.parse(trimmed);
    }
    return value;
  }

  function summarizeState(state) {
    if (!state || typeof state !== 'object') return '';
    const milestones = Array.isArray(state.milestones) ? state.milestones : [];
    const open = milestones.filter((m) => m?.status !== 'done' && m?.verified !== true).length;
    return [
      `objective: ${state.objective ?? '(none)'}`,
      `phase: ${state.phase ?? '?'}  approved: ${state.approved === true ? 'yes' : 'no'}`,
      `milestones: ${milestones.length} (${open} open)`,
    ].join('\n');
  }

  async function runAction(action, args, cwd) {
    if (action === 'where') {
      return {
        ok: true,
        text: [
          `plugin: ${PKG_DIR}`,
          `vendored engine: ${VENDOR_DIR}`,
          `hooks: ${HOOKS_DIR}`,
          `cli: ${CLI_PATH}`,
          `skills: ${SKILLS_DIR}`,
          `roles: ${AGENTS_DIR}`,
          `workspace: ${cwd}`,
        ].join('\n'),
      };
    }

    if (action === 'role') {
      const role = String(args.role ?? '').trim().toLowerCase();
      const file = join(AGENTS_DIR, `${role}.md`);
      if (!role || !existsSync(file)) {
        return { ok: false, text: `unknown role "${args.role ?? ''}"; choose one of: ${listRoles().join(', ')}` };
      }
      const { frontmatter, body } = parseFrontmatter(readFileSync(file, 'utf8'));
      const tools = frontmatter.tools ?? '';
      const maxTurns = frontmatter.maxTurns ?? '';
      return {
        ok: true,
        text: [
          `# Role: ${frontmatter.name ?? role}`,
          frontmatter.description ? `> ${frontmatter.description}` : '',
          tools ? `Tool guidance: ${tools}` : '',
          maxTurns ? `Suggested turn budget: ${maxTurns}` : '',
          '',
          body.trim(),
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }

    if (action === 'roles') {
      return { ok: true, text: listRoles().join('\n') };
    }

    if (action === 'tier') {
      const task = String(args.task ?? args.objective ?? '');
      const files = typeof args.files === 'string' && args.files.length > 0 ? args.files.split(',') : [];
      const recommendation = await recommendTier(task, files);
      return {
        ok: true,
        text: [
          `Recommended tier: ${recommendation.tier.toUpperCase()} (${recommendation.config.title})`,
          recommendation.config.summary,
          `Active roles: ${recommendation.config.activeRoles.join(', ')}`,
          'Reasons:',
          ...recommendation.reasons.map((reason) => `- ${reason}`),
        ].join('\n'),
      };
    }

    if (action === 'watchdog') {
      const wd = await watchdog();
      const stateDir = join(cwd, '.teamwork');
      const health = wd.inspectHealth({ cwd, stateDir });
      if (args.heal === true && (health.status === 'deadlocked' || (health.expiredLeases?.length ?? 0) > 0 || (health.abandonedReservations?.length ?? 0) > 0)) {
        const healed = wd.healHealth({ cwd, stateDir });
        return { ok: true, text: `Watchdog healed: ${JSON.stringify(healed)}` };
      }
      return { ok: true, text: `Watchdog: ${JSON.stringify(health)}` };
    }

    if (action === 'dashboard') {
      const engine = await engineFor(cwd);
      const campaign = engine.load();
      const status = engine.status();
      const render = await dashboardRenderer();
      return { ok: true, text: render(campaign, { dispatchesCount: status?.dispatches ?? 0 }) };
    }

    const engine = await engineFor(cwd);
    switch (action) {
      case 'init': {
        const result = engine.initProject({
          objective: args.objective,
          mode: args.mode,
          integrityMode: args.integrity,
          executionPath: args.path,
          pattern: args.pattern,
          force: args.force === true,
        });
        return result.ok
          ? { ok: true, text: `Campaign created.\n${summarizeState(result.state)}\nNext: interview the human, write milestones, then \`approve\`.` }
          : { ok: false, text: `Refused: ${result.reason}` };
      }
      case 'approve': {
        const result = engine.approve();
        return result.ok
          ? { ok: true, text: `Approved. ${result.state.milestones.length} milestone(s) will run.\n${summarizeState(result.state)}\nNext: \`advance\` to executing.` }
          : { ok: false, text: `Refused: ${result.reason}` };
      }
      case 'advance': {
        if (typeof args.phase !== 'string' || args.phase.length === 0) return { ok: false, text: 'advance needs a phase' };
        const result = engine.advance(args.phase);
        return result.ok ? { ok: true, text: `Phase: ${result.state.phase}` } : { ok: false, text: `Refused: ${result.reason}` };
      }
      case 'cancel': {
        const result = engine.cancel(args.reason);
        return result.ok ? { ok: true, text: 'Campaign aborted.' } : { ok: false, text: `Refused: ${result.reason}` };
      }
      case 'decompose': {
        const result = engine.decompose({ objective: args.objective });
        if (!result.ok) return { ok: false, text: `Refused: ${result.reason}` };
        return {
          ok: true,
          text: [
            `Draft (${result.milestones.length} milestones, ${result.workspace_file_count} files seen):`,
            ...result.milestones.map(
              (m) => `- [${m.id}] ${m.deliverable} (owner ${m.owner_role}, verified by ${m.verified_by}${m.blocked_by?.length ? `, blocked by ${m.blocked_by.join(', ')}` : ''})`,
            ),
            '',
            result.note,
          ].join('\n'),
        };
      }
      case 'plan': {
        const milestones = parseJsonish(args.milestones, undefined);
        if (!Array.isArray(milestones)) return { ok: false, text: 'plan needs `milestones` as a JSON array' };
        const result = engine.createPlan(milestones);
        return result.ok
          ? { ok: true, text: `Plan accepted: ${result.state.milestones.length} milestone(s), ownership recorded.` }
          : { ok: false, text: `Refused: ${result.reason}` };
      }
      case 'schedule': {
        const result = engine.getSchedule();
        if (!result.ok) return { ok: false, text: `Refused: ${result.error ?? result.reason}` };
        return {
          ok: true,
          text: [
            `Batches: ${result.batches.length}`,
            ...result.batches.map((batch) => `- batch ${batch.index}: ${batch.milestones.join(', ')}${batch.parallel ? ' (parallel)' : ''}${batch.files.length ? ` — ${batch.files.join(', ')}` : ''}`),
            `Worker dispatches needed: ${result.worker_dispatches} of ${result.budget}`,
            ...result.warnings.map((warning) => `WARNING ${warning}`),
          ].join('\n'),
        };
      }
      case 'claim': {
        const result = engine.claimFile(args.file, args.milestone, {
          role: args.role,
          leaseMinutes: typeof args.lease === 'number' ? args.lease : undefined,
        });
        return result.ok ? { ok: true, text: `Claimed ${result.entry.file} for ${result.entry.milestone} until ${result.entry.expiresAt}` } : { ok: false, text: `Refused: ${result.reason}` };
      }
      case 'release': {
        const result = engine.releaseFile(args.file, args.milestone);
        return result.ok ? { ok: true, text: `Released ${args.file}` } : { ok: false, text: `Refused: ${result.reason}` };
      }
      case 'can-write': {
        const result = engine.canWrite(args.file, args.milestone);
        return { ok: Boolean(result.allowed), text: result.allowed ? `Allowed${result.unclaimed ? ' (unclaimed)' : ''}` : `Denied: ${result.reason}` };
      }
      case 'check': {
        const result = engine.planVerification(args.milestone, { affectedFiles: typeof args.affected === 'number' ? args.affected : undefined });
        if (!result.ok) return { ok: false, text: `Refused: ${result.reason}` };
        return {
          ok: true,
          text: [
            `Verification sizing: ${result.sizing.reviewers} reviewer(s), ${result.sizing.challengers} challenger(s), ${result.sizing.auditor} auditor`,
            ...result.sizing.reasons.map((reason) => `- ${reason}`),
            ...result.prompts.map((prompt, index) => `--- prompt ${index + 1} ---\n${prompt}`),
          ].join('\n'),
        };
      }
      case 'verify': {
        const verdicts = parseJsonish(args.verdicts, undefined);
        if (!Array.isArray(verdicts)) return { ok: false, text: 'verify needs `verdicts` as a JSON array' };
        const result = engine.verifyMilestone(args.milestone, verdicts);
        if (!result.ok) return { ok: false, text: `Refused: ${result.reason}` };
        return {
          ok: true,
          text: [`Gate: ${result.gate.result} — ${result.gate.reason}`, ...result.gate.findings.map((finding) => `! ${finding}`), result.repair ? `Repair workstream created: ${result.repair.id}` : '']
            .filter(Boolean)
            .join('\n'),
        };
      }
      case 'final': {
        const verdicts = parseJsonish(args.verdicts, undefined);
        if (!Array.isArray(verdicts)) return { ok: false, text: 'final needs `verdicts` as a JSON array' };
        const result = engine.finalVerification(verdicts);
        return result.ok
          ? { ok: true, text: 'Final audit passed; campaign complete.' }
          : { ok: false, text: `Refused: ${result.reason ?? (result.findings ?? []).join('; ')}` };
      }
      case 'status': {
        const result = engine.status();
        if (!result.ok) return { ok: false, text: `No campaign: ${result.reason}` };
        const lines = [
          `Objective: ${result.objective}`,
          `Phase: ${result.phase}   Mode: ${result.mode}   Integrity: ${result.integrityMode}   State v${result.version}`,
          '',
          `Milestones (${result.milestones.length}, ${result.open.length} open):`,
          ...result.milestones.map((m) => `- [${m.verified ? 'x' : ' '}] ${m.id}  ${m.status}${m.files.length ? `  (${m.files.join(', ')})` : ''}`),
        ];
        if (result.ownership.length > 0) {
          lines.push('', `Ownership (${result.ownership.length}):`, ...result.ownership.map((entry) => `- ${entry.file} -> ${entry.milestone}`));
        }
        if (result.gates.length > 0) {
          lines.push('', 'Gates:', ...result.gates.map((gate) => `- ${gate.milestone}: ${gate.result}`));
        }
        lines.push('', `Journal: ${result.journal.total} entries, last ${result.journal.last ?? '(none)'}`);
        lines.push(`Dispatches: ${result.dispatches} of ${result.spawnBudget}${result.journal.agents.length > 0 ? ` (${result.journal.agents.join(', ')})` : ''}`);
        if (result.complete) lines.push('Campaign is complete and fully verified.');
        return { ok: true, text: lines.join('\n') };
      }
      case 'stale': {
        const result = engine.staleness();
        if (!result.stalled) return { ok: true, text: `Not stalled${result.reason ? ` (${result.reason})` : ''}.` };
        return { ok: true, text: ['Signals:', ...result.signals.map((signal) => `- [${signal.kind}] ${signal.detail}`)].join('\n') };
      }
      case 'handoff': {
        const result = engine.handoff(args.reason);
        if (!result.ok) return { ok: false, text: `Refused: ${result.reason}` };
        const { renderHandoff } = await loadLibModule('handoff.mjs');
        return { ok: true, text: renderHandoff(result) };
      }
      case 'patterns': {
        const result = engine.listPatterns();
        return {
          ok: true,
          text: result.patterns.map((p) => `${p.id}\n  ${p.title}: ${p.summary}\n  Use when: ${p.whenToUse}`).join('\n'),
        };
      }
      case 'pattern': {
        if (typeof args.set === 'string' && args.set.length > 0) {
          const result = engine.setPattern(args.set);
          return result.ok ? { ok: true, text: `Pattern set.\n\n${result.description}` } : { ok: false, text: `Refused: ${result.reason}` };
        }
        if (args.suggest !== undefined) {
          const text = typeof args.suggest === 'string' ? args.suggest : undefined;
          const result = engine.suggestPattern(text);
          return result.ok ? { ok: true, text: `Suggested: ${result.pattern}\n\n${result.description}` } : { ok: false, text: `Refused: ${result.reason}` };
        }
        const result = engine.pattern();
        return result.ok ? { ok: true, text: result.description } : { ok: false, text: `Refused: ${result.reason}` };
      }
      case 'isolation': {
        if (typeof args.prepare === 'string' && args.prepare.length > 0) {
          const result = engine.prepareIsolation(args.prepare, { mode: args.mode });
          const { describeIsolation } = await loadLibModule('isolation.mjs');
          return result.ok ? { ok: true, text: describeIsolation(result) } : { ok: false, text: `Refused: ${result.reason}` };
        }
        const result = engine.isolationPlan(args.workstream ?? 'example');
        return { ok: true, text: `Isolation tier for this workspace: ${result.mode}\n${result.reason}` };
      }
      case 'briefing': {
        const result = engine.briefing(args.reason);
        return result.ok ? { ok: true, text: result.briefing } : { ok: false, text: `Refused: ${result.reason}` };
      }
      case 'succession': {
        const result = engine.successionCheck();
        if (!result.ok) return { ok: false, text: `Refused: ${result.reason}` };
        return {
          ok: true,
          text: `Dispatches used: ${result.used} of ${result.budget}\n${result.shouldPrepare ? `A briefing should be written: ${result.reason}` : 'No briefing needed yet.'}`,
        };
      }
      case 'blackboard-post': {
        const update = parseJsonish(args.update, undefined);
        if (update === undefined) return { ok: false, text: 'blackboard-post needs `update`' };
        const result = engine.postBlackboard(update);
        return result.ok !== false ? { ok: true, text: 'Blackboard updated.' } : { ok: false, text: `Refused: ${result.reason ?? 'update rejected'}` };
      }
      case 'blackboard': {
        const filter = parseJsonish(args.filter, undefined);
        const result = engine.getBlackboard(filter ?? {});
        return { ok: true, text: JSON.stringify(result, null, 2) };
      }
      case 'pitfalls': {
        const filter = parseJsonish(args.filter, undefined);
        const result = engine.pitfalls(filter ?? {});
        return { ok: true, text: JSON.stringify(result, null, 2) };
      }
      case 'record-pitfall': {
        const entry = parseJsonish(args.entry, undefined);
        if (entry === undefined) return { ok: false, text: 'record-pitfall needs `entry`' };
        const result = engine.recordPitfall(entry);
        return { ok: true, text: JSON.stringify(result, null, 2) };
      }
      case 'synthesis': {
        const result = engine.synthesisBrief({});
        return { ok: true, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) };
      }
      default:
        return { ok: false, text: `unknown teamwork action "${action}"` };
    }
  }

  // -- Read-only live surface for the visual panel -------------------------
  //
  // The browser panel cannot read .teamwork itself, so the host serves one
  // exact, loopback-only JSON route. It is a projection, never a feed of
  // fabricated states: no campaign means idle.

  ctx.inject(['webServer'], (scoped) => {
    const sendJson = (res, status, value) => {
      const body = JSON.stringify(value);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-cache',
      });
      res.end(body);
    };
    const isLoopback = (value) => {
      if (typeof value !== 'string' || value.length === 0) return false;
      const bare = value.startsWith('::ffff:') ? value.slice(7) : value;
      if (bare === '::1' || bare === 'localhost') return true;
      return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
    };
    const hostName = (value) => {
      if (typeof value !== 'string' || value.length === 0) return '';
      if (value.startsWith('[')) return value.slice(1, value.indexOf(']'));
      const colon = value.lastIndexOf(':');
      return colon === -1 ? value : value.slice(0, colon);
    };
    const handler = async (req, res) => {
      if (req?.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      const peerOk = isLoopback(req.socket?.remoteAddress);
      const hostOk = isLoopback(hostName(req.headers?.host));
      if (!peerOk || !hostOk) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      let cwd;
      try {
        cwd = new URL(req.url ?? '/', 'http://localhost').searchParams.get('cwd') ?? undefined;
      } catch {
        cwd = undefined;
      }
      try {
        sendJson(res, 200, liveState(cwd));
      } catch (error) {
        warn('live state failed', error);
        sendJson(res, 200, liveState(undefined));
      }
    };
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'exact',
          path: '/api/teamwork/live',
          handler,
        }),
      'teamwork live route',
    );
  });

  // -- Human commands -------------------------------------------------------

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'teamwork',
      description: 'Open a Teamwork campaign: scope the objective, interview, then run a multi-agent team with independent verification.',
      input: { hint: '<objective>' },
      async handler(invocation) {
        const raw = String(invocation.rawInput ?? '').trim();
        if (raw.length === 0) {
          return { kind: 'error', text: 'Usage: /teamwork "<objective>"' };
        }
        const objective = raw;
        const cwd = sessionCwd(ctx, invocation.agent);
        let tierLine = '';
        try {
          const recommendation = await recommendTier(objective, []);
          tierLine = [
            `Engine tier recommendation: ${recommendation.tier.toUpperCase()} (${recommendation.config.title})`,
            `Summary: ${recommendation.config.summary}`,
            `Active roles: ${recommendation.config.activeRoles.join(', ')}`,
            `Reasons: ${recommendation.reasons.join('; ')}`,
          ].join('\n');
        } catch (error) {
          warn('tier recommendation failed', error);
        }
        const text = [
          'Open a Teamwork campaign for this objective:',
          '',
          objective,
          '',
          'Run Phase 1 — Specify What, Not How. First call the `skill` tool with name "teamwork" and follow it exactly.',
          '',
          tierLine,
          '',
          'Rules for this Harness:',
          '- Drive campaign state with the `teamwork` tool. Create the charter with `{"action":"init","objective":"..."}` (or write .teamwork/campaign.json directly), record milestones with `{"action":"plan","milestones":[...]}`, and only then `{"action":"approve"}` followed by `{"action":"advance","phase":"executing"}`.',
          '- The ownership hooks arm only when .teamwork/campaign.json has "approved": true and its phase is one of approved/executing/verifying. "execution" is NOT a valid phase — use "executing".',
          '- Source changes use the `write` and `edit` tools only; `pwsh` is the shell and is guarded separately. Never let two Workers own the same file.',
          '- Dispatch with `subagent`, `subagent_fork` or `spawn_teammate` (they count as Agent dispatches against the spawn budget). Load role prompts with the `teamwork` tool: {"action":"role","role":"worker"} etc.',
          '- Independent verification is a file: .teamwork/verifications/<milestone>.md written by a verifier that did NOT implement it, and .teamwork/final-audit.md concluding ACHIEVED. The Stop gate is enforced at turn end on this Harness too.',
          '- Do not dispatch any Worker and do not start implementing until the human has approved the charter.',
          '',
          'While running: /teamwork-status shows the live dashboard, /teamwork-end archives the campaign.',
        ].join('\n');
        invocation.agent.steer(userNote(text, 'Teamwork campaign opened'));
        commandCtx.logger?.info?.('teamwork: campaign prompt steered for %s', objective);
        void cwd;
        return { kind: 'success', text: `Teamwork campaign opened.\n${tierLine ? `${tierLine.split('\n')[0]}\n` : ''}The scoping interview starts in the next step; the engine is at ${CLI_PATH}.` };
      },
    });

    commandCtx.commands.register({
      name: 'teamwork-status',
      description: 'Show the Teamwork campaign dashboard: milestones, ownership leases, verification gaps, hook state and recent activity. Read-only.',
      async handler(invocation) {
        const cwd = sessionCwd(ctx, invocation.agent);
        const engine = await engineFor(cwd);
        const campaign = engine.load();
        if (!campaign) return { kind: 'success', text: 'No Teamwork campaign in this workspace. Run /teamwork "<objective>" to open one.' };
        const status = engine.status();
        const render = await dashboardRenderer();
        const dashboard = render(campaign, { dispatchesCount: status?.dispatches ?? 0 });
        const milestones = Array.isArray(campaign.milestones) ? campaign.milestones : [];
        const verificationsDir = join(cwd, '.teamwork', 'verifications');
        let records = [];
        try {
          records = existsSync(verificationsDir) ? readdirSync(verificationsDir).filter((entry) => entry.endsWith('.md')) : [];
        } catch {
          records = [];
        }
        const gaps = milestones.filter((m) => m?.status === 'done' || m?.verified === true).map((m) => String(m.id ?? '?')).filter((id) => !records.some((record) => record.toLowerCase().includes(id.toLowerCase())));
        const armed = isActiveCampaign(campaign);
        const lines = [
          dashboard,
          '',
          '### Harness bridge state',
          `- Ownership / spawn / verification hooks: ${armed ? 'ARMED' : 'INERT'}${armed ? '' : ` (approved=${campaign.approved === true}, phase=${campaign.phase ?? '?'})`}`,
          `- Verification records on disk: ${records.length === 0 ? 'none' : records.join(', ')}`,
          `- Milestones marked done without a record: ${gaps.length === 0 ? 'none' : gaps.join(', ')}`,
          `- Final audit: ${existsSync(join(cwd, '.teamwork', 'final-audit.md')) ? 'present' : 'missing'}`,
          `- Vendored engine: ${VENDOR_DIR}`,
        ];
        return { kind: 'success', text: lines.join('\n') };
      },
    });

    commandCtx.commands.register({
      name: 'teamwork-end',
      description: 'Close the current Teamwork campaign: archive its state to .teamwork/history/ and disarm the ownership hooks. Run with "confirm" after reviewing the report.',
      input: { hint: 'confirm' },
      async handler(invocation) {
        const cwd = sessionCwd(ctx, invocation.agent);
        const campaignFile = join(cwd, '.teamwork', 'campaign.json');
        if (!existsSync(campaignFile)) return { kind: 'success', text: 'No Teamwork campaign is running in this workspace; nothing to close.' };
        const campaign = campaignState(cwd) ?? {};
        const confirm = String(invocation.rawInput ?? '').trim().toLowerCase() === 'confirm';
        if (!confirm) {
          const finalAuditPath = join(cwd, '.teamwork', 'final-audit.md');
          const verdict = existsSync(finalAuditPath) ? readFileSync(finalAuditPath, 'utf8').slice(0, 4000).match(/ACHIEVED|PARTIALLY ACHIEVED|NOT ACHIEVED/i)?.[0] : undefined;
          return {
            kind: 'success',
            text: [
              'Closing a campaign archives its state and disarms the ownership hooks; ordinary editing becomes unrestricted again.',
              `Objective: ${campaign.objective ?? '(none)'}`,
              `Phase: ${campaign.phase ?? '?'}   Approved: ${campaign.approved === true ? 'yes' : 'no'}`,
              `Final audit verdict: ${verdict ?? 'missing (closing without a final audit is a real gap)'}`,
              '',
              'Review the campaign with /teamwork-status, then run `/teamwork-end confirm` to archive it.',
            ].join('\n'),
          };
        }
        const archive = archiveCampaign(cwd);
        try {
          await refreshChartersForCwd(cwd);
        } catch {
          // the archive report stands even if the context refresh fails
        }
        return { kind: 'success', text: archive };
      },
    });
  });

  // -- Skills ---------------------------------------------------------------

  ctx.inject(['skills'], (skillCtx) => {
    for (const [dir, skillName] of [
      ['teamwork', 'teamwork'],
      ['teamwork-execute', 'teamwork-execute'],
    ]) {
      const file = join(SKILLS_DIR, dir, 'SKILL.md');
      if (!existsSync(file)) continue;
      try {
        const { frontmatter, body } = parseFrontmatter(readFileSync(file, 'utf8'));
        let content = body;
        // The source skill's example phase name is not one the hooks accept.
        content = content.replaceAll('phase: "execution"', 'phase: "executing"').replaceAll('"phase": "execution"', '"phase": "executing"');
        content += `\n\n## Harness adaptation (DeepSeek Harness)\n\nThis skill runs on DeepSeek Harness through the \`teamwork\` plugin.\n\n- Load a role prompt with the \`teamwork\` tool: \`{"action":"role","role":"worker"}\` and pass the returned body into \`subagent\`, \`subagent_fork\` or \`spawn_teammate\`.\n- Campaign verbs are the \`teamwork\` tool actions: ${ACTIONS.join(', ')}. \`/teamwork\`, \`/teamwork-status\` and \`/teamwork-end\` are registered as slash commands.\n- Ownership, dispatch-budget, audit and verification hooks are bridged from the original ZCode hooks; a write to a file held by another Worker is denied at \`write\`/\`edit\`, and shell writes are checked for \`pwsh\`.\n- Use \`write\`/\`edit\` for source changes. The verify/success-audit record paths and verdict words are unchanged: \`.teamwork/verifications/<milestone>.md\` and \`.teamwork/final-audit.md\`.\n- The engine lives at ${VENDOR_DIR}; run it directly with \`node "${CLI_PATH}" <verb> --json\` if you need the raw CLI.\n`;
        skillCtx.skills.register({
          name: skillName,
          description: String(frontmatter.description ?? 'Teamwork campaign skill.'),
          whenToUse: frontmatter.when_to_use ?? frontmatter.whenToUse,
          content,
          source: 'runtime',
          invocation: { modelInvocable: true, userInvocable: true },
        });
      } catch (error) {
        warn(`failed to register skill ${skillName}`, error);
      }
    }
  });

  // -- Resident watchdog ----------------------------------------------------

  ctx.effect(() => {
    const tick = async () => {
      try {
        for (const agent of ctx.get('agents')?.list?.() ?? []) {
          try {
            await refreshCharter(agent);
          } catch {
            // one session's charter is not the tick's whole job
          }
        }
        const seen = new Set();
        for (const agent of ctx.get('agents')?.list?.() ?? []) {
          const cwd = sessionCwd(ctx, agent);
          if (seen.has(cwd)) continue;
          seen.add(cwd);
          const campaign = campaignState(cwd);
          if (!isActiveCampaign(campaign)) continue;
          const wd = await watchdog();
          const health = wd.inspectHealth({ cwd, stateDir: join(cwd, '.teamwork') });
          if (health.status === 'deadlocked' || (health.expiredLeases?.length ?? 0) > 0 || (health.abandonedReservations?.length ?? 0) > 0) {
            wd.healHealth({ cwd, stateDir: join(cwd, '.teamwork') });
          }
        }
      } catch {
        // a watchdog tick must never surface as a session error
      }
    };
    const timer = setInterval(tick, WATCHDOG_INTERVAL_MS);
    if (timer.unref) timer.unref();
    return () => clearInterval(timer);
  }, 'teamwork watchdog');

  // Warm the charter cache for sessions that already existed before this load.
  for (const agent of ctx.get('agents')?.list?.() ?? []) {
    void refreshCharter(agent, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { frontmatter: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { frontmatter: {}, body: text };
  const raw = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const frontmatter = {};
  let currentKey;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) {
      currentKey = match[1];
      frontmatter[currentKey] = match[2].trim();
    } else if (currentKey && /^\s+/.test(line)) {
      frontmatter[currentKey] = `${frontmatter[currentKey]} ${line.trim()}`.trim();
    }
  }
  return { frontmatter, body };
}

function listRoles() {
  try {
    return readdirSync(AGENTS_DIR)
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => basename(entry, '.md'))
      .sort();
  } catch {
    return [];
  }
}

function archiveCampaign(cwd) {
  const stateDir = join(cwd, '.teamwork');
  const campaign = readJson(join(stateDir, 'campaign.json')) ?? {};
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
  const target = join(stateDir, 'history', stamp);
  mkdirSync(target, { recursive: true });
  const moved = [];
  for (const entry of ['campaign.json', 'plan.json', 'ownership.json', 'events.jsonl', 'spawn-reservations.json', 'verifications', 'final-audit.md']) {
    const from = join(stateDir, entry);
    if (!existsSync(from)) continue;
    try {
      renameSync(from, join(target, entry));
      moved.push(entry);
    } catch {
      // a locked file leaves the campaign partially archived; report it
    }
  }
  // A stale mutex must not delay the next campaign.
  try {
    rmSync(join(stateDir, '.lock'), { recursive: true, force: true });
  } catch {
    // ignore
  }
  try {
    for (const entry of readdirSync(stateDir)) {
      if (!entry.endsWith('.tmp')) continue;
      rmSync(join(stateDir, entry), { force: true });
    }
  } catch {
    // ignore
  }
  const auditPath = join(target, 'final-audit.md');
  const verdict = existsSync(auditPath) ? readFileSync(auditPath, 'utf8').slice(0, 4000).match(/ACHIEVED|PARTIALLY ACHIEVED|NOT ACHIEVED/i)?.[0] : undefined;
  return [
    `Campaign archived to .teamwork/history/${stamp}/.`,
    `Objective: ${campaign.objective ?? '(none)'}`,
    `Final state: phase ${campaign.phase ?? '?'}, approved ${campaign.approved === true ? 'yes' : 'no'}`,
    `Moved: ${moved.length === 0 ? '(nothing)' : moved.join(', ')}`,
    `Final audit: ${verdict ?? 'missing — the campaign was closed without one'}`,
    'The ownership hooks are now INERT. /teamwork "<objective>" starts a fresh campaign.',
  ].join('\n');
}
