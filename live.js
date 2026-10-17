// Read-only campaign projection for the live Teamwork panel.
//
// The panel must never invent activity: every state below is derived from
// <cwd>/.teamwork (campaign.json, events.jsonl, verifications/, final-audit.md)
// and an idle campaign stays idle. Pure Node built-ins; no dependencies.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

export const ROLE_IDS = [
  'sentinel', 'orch', 'explorer', 'critic', 'test', 'challenger',
  'worker', 'spec', 'empirical', 'auditor', 'success',
];

const IDLE_TICKER = ['等待战役开始 · 运行 /teamwork 开启一个战役'];

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJson(path) {
  try {
    return JSON.parse(stripBom(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

function tailEvents(path, limit = 160) {
  try {
    const text = stripBom(readFileSync(path, 'utf8'));
    const lines = text.split('\n');
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const value = JSON.parse(line);
        if (value && typeof value === 'object') out.push(value);
      } catch {
        // a torn tail is not an event
      }
    }
    return out.reverse();
  } catch {
    return [];
  }
}

function rolesAll(state) {
  return Object.fromEntries(ROLE_IDS.map((id) => [id, state]));
}

export function idleState(reason) {
  return {
    ok: true,
    active: false,
    objective: reason ?? '当前没有进行中的战役',
    phase: '待命',
    approved: false,
    progress: { done: 0, total: 0 },
    robots: rolesAll('idle'),
    ticker: IDLE_TICKER,
    updatedAt: Date.now(),
  };
}

function verificationRecords(dir) {
  try {
    return readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.md'));
  } catch {
    return [];
  }
}

function newestMtime(dir, names) {
  let newest = 0;
  for (const name of names) {
    try {
      newest = Math.max(newest, statSync(join(dir, name)).mtimeMs);
    } catch {
      // missing is not a signal
    }
  }
  return newest;
}

function shortFile(file) {
  if (typeof file !== 'string' || file.length === 0) return '';
  return basename(file.replaceAll('\\', '/'));
}

function agentName(event) {
  const value = event?.agent ?? event?.subagent_type ?? event?.task;
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function recent(events, ms) {
  const now = Date.now();
  return events.filter((event) => typeof event?.t === 'number' && now - event.t <= ms);
}

function tickerOf(events) {
  const lines = [];
  for (let i = events.length - 1; i >= 0 && lines.length < 4; i--) {
    const event = events[i];
    const file = shortFile(event?.file);
    switch (event?.event) {
      case 'claimed':
        if (file) lines.push(`登记文件租约 · ${file}`);
        break;
      case 'denied':
        if (file) lines.push(`写入被拒 · ${file}`);
        break;
      case 'dispatch':
        lines.push(`派发子代理 · ${agentName(event) || '协作代理'}`);
        break;
      case 'expired':
        lines.push(`看门狗 · 回收过期租约${file ? ` · ${file}` : ''}`);
        break;
      case 'tool':
        lines.push(`执行 ${event?.tool ?? '工具'}${file ? ` · ${file}` : ''}`);
        break;
      case 'charter-approved':
        lines.push('宪章已批准 · 进入执行阶段');
        break;
      case 'phase-changed':
        lines.push(`阶段切换 · ${event?.phase ?? '执行中'}`);
        break;
      case 'verdict':
        lines.push(`验证结论 · ${event?.result ?? event?.verdict ?? '已记录'}`);
        break;
      default:
        break;
    }
  }
  return lines.length > 0 ? lines : IDLE_TICKER;
}

export function liveState(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd) || !existsSync(cwd)) {
    return idleState('当前会话没有可用的工作目录');
  }
  const stateDir = join(cwd, '.teamwork');
  const campaign = readJson(join(stateDir, 'campaign.json'));
  if (!campaign) return idleState('当前工作区没有进行中的战役');

  const milestones = Array.isArray(campaign.milestones) ? campaign.milestones : [];
  const done = milestones.filter((m) => m?.verified === true || m?.status === 'done').length;
  const events = tailEvents(join(stateDir, 'events.jsonl'));
  const recentEvents = recent(events, 120_000);
  const recent60 = recent(events, 60_000);
  const recent30 = recent(events, 30_000);
  const verifications = verificationRecords(join(stateDir, 'verifications'));
  const verificationMtime = newestMtime(join(stateDir, 'verifications'), verifications);
  const finalAudit = existsSync(join(stateDir, 'final-audit.md'));
  const phase = String(campaign.phase ?? 'scoping');
  const pattern = String(campaign.pattern ?? '');
  const approved = campaign.approved === true;

  const dispatchNames = recentEvents
    .filter((event) => event?.event === 'dispatch')
    .map((event) => agentName(event).toLowerCase());
  const hasDispatch = (word) => dispatchNames.some((name) => name.includes(word));
  const recentlyVerified = verificationMtime > 0 && Date.now() - verificationMtime < 120_000;

  const robots = rolesAll('idle');

  // sentinel: the gate runs while the charter is still being scoped.
  if (phase === 'scoping' || phase === 'charter') robots.sentinel = 'work';
  else if (approved) robots.sentinel = 'done';

  // orchestrator: planning until a milestone table exists.
  if (approved) robots.orch = milestones.length === 0 ? 'work' : phase === 'executing' ? 'work' : 'done';

  // workers: any recent claim / write / dispatch; a recent denial wins.
  const denied = recent30.some((event) => event?.event === 'denied');
  const workerActivity = recent60.some((event) =>
    event?.event === 'claimed' ||
    event?.event === 'dispatch' ||
    (event?.event === 'tool' && (event?.tool === 'Write' || event?.tool === 'Edit' || event?.tool === 'Bash')));
  if (denied) robots.worker = 'blocked';
  else if (workerActivity || hasDispatch('worker')) robots.worker = 'work';

  if (hasDispatch('explorer') || hasDispatch('explor')) robots.explorer = 'work';
  if (hasDispatch('test')) robots.test = 'work';
  if (hasDispatch('spec')) robots.spec = 'work';
  if (hasDispatch('empirical') || hasDispatch('fuzz')) robots.empirical = 'work';

  // verifiers: a fresh verification record is the only "verify" signal.
  if (recentlyVerified) {
    robots.critic = 'verify';
    robots.auditor = 'verify';
  }
  if (pattern.includes('adversarial') && approved) robots.challenger = 'verify';
  if (finalAudit) {
    robots.success = 'done';
    robots.auditor = 'done';
    robots.critic = 'done';
  } else if (phase === 'complete') {
    robots.success = 'work';
  }

  return {
    ok: true,
    active: true,
    objective: String(campaign.objective ?? '未命名的战役'),
    phase,
    approved,
    pattern,
    progress: { done, total: milestones.length },
    robots,
    ticker: tickerOf(recentEvents),
    updatedAt: Date.now(),
  };
}
