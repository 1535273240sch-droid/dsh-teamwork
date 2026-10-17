/**
 * Teamwork live panel — Client half.
 *
 * Registers one frame-wide overlay entry (shell.overlay) that auto-opens on
 * load and animates the eleven campaign roles. States come from the host's
 * read-only /api/teamwork/live projection; the panel never invents work.
 */
window.__ModuleLoader__.load({
  id: 'dsh-teamwork',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    const CSS = `
    .tw-root{position:fixed;top:64px;right:14px;bottom:92px;width:384px;z-index:60;pointer-events:none;
      font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif;color:#e6f0ff}
    .tw-root.tw-collapsed{top:auto;bottom:120px;width:52px;height:136px}
    .tw-pill{pointer-events:auto;width:52px;height:136px;border-radius:16px;border:1px solid #203355;
      background:linear-gradient(180deg,#0b1424,#070d18);display:flex;flex-direction:column;align-items:center;
      justify-content:center;gap:8px;cursor:pointer;color:#bfe3ff;box-shadow:0 10px 30px #000a}
    .tw-pill:hover{border-color:#2c4a7f}
    .tw-pill-text{writing-mode:vertical-rl;letter-spacing:4px;font-size:11px}
    .tw-pill-count{font-size:9px;color:#7f93bb}
    .tw-panel{pointer-events:auto;width:100%;height:100%;border-radius:20px;border:1px solid #203355;
      background:linear-gradient(180deg,#0b1424f5 0%,#070d18f7 100%);
      box-shadow:0 30px 70px #000c,inset 0 1px 0 #ffffff10;display:flex;flex-direction:column;overflow:hidden;position:relative}
    .tw-panel:before{content:"";position:absolute;inset:0;pointer-events:none;
      background:radial-gradient(360px 140px at 85% -2%,#22d3ee14,transparent 70%)}
    .tw-head{padding:13px 14px 9px;border-bottom:1px solid #1a2947;position:relative;z-index:2}
    .tw-row1{display:flex;align-items:center;gap:8px}
    .tw-live-dot{width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 14px #34d399;
      animation:tw-pulse 1.6s infinite;flex:0 0 auto}
    .tw-head h1{font-size:12.5px;margin:0;letter-spacing:1.2px;font-weight:700;color:#d9ecff;
      flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tw-phase{flex:0 0 auto;font-size:10px;color:#a7f3d8;border:1px solid #1d5c4a;background:#0b2a22;
      border-radius:999px;padding:2px 8px;letter-spacing:.5px}
    .tw-fold{flex:0 0 auto;margin-left:2px;width:20px;height:20px;border-radius:6px;border:1px solid #24395e;
      background:#0c1729;color:#8fb3dd;font-size:12px;line-height:1;cursor:pointer;padding:0}
    .tw-fold:hover{background:#12203a}
    .tw-obj{margin-top:6px;font-size:11.5px;color:#9fb2d8;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tw-progress{margin-top:7px;display:flex;align-items:center;gap:8px}
    .tw-bar{flex:1;height:5px;border-radius:99px;background:#0d1930;overflow:hidden}
    .tw-bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#22d3ee,#6366f1 70%,#a78bfa);
      box-shadow:0 0 14px #22d3ee88;transition:width .9s cubic-bezier(.2,.9,.2,1)}
    .tw-progress b{font-size:10.5px;color:#a9dcff;font-weight:600}
    .tw-stage{position:relative;flex:1;margin:2px 6px 0;min-height:0}
    .tw-wires{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
    .tw-wire{fill:none;stroke:#1b2b49;stroke-width:1.2;opacity:.8}
    .tw-wire-live{stroke:#2f6f9e;opacity:.5;stroke-dasharray:4 8;animation:tw-dash 3.4s linear infinite}
    .tw-wire-warn{stroke:#8a5a17;opacity:.55;stroke-dasharray:3 8}
    .tw-wire-active.tw-wire-live{stroke:#22d3ee;opacity:.85;animation:tw-dash 1.2s linear infinite}
    .tw-wire-active.tw-wire-base{stroke:#2b6f9e;opacity:.6}
    .tw-wire-active.tw-wire-warn{stroke:#f59e0b;opacity:.8;animation:tw-dash 1.6s linear infinite}
    .tw-node{position:absolute;transform:translate(-50%,-50%);width:86px;text-align:center;z-index:3;
      cursor:pointer;transition:opacity .4s}
    .tw-node.tw-idle{opacity:.74}
.tw-node.tw-idle .tw-halo{opacity:.26;animation:tw-halo 3.8s ease-in-out infinite}
.tw-node.tw-idle .tw-robot{animation-duration:4.4s}
    .tw-halo{position:absolute;left:50%;top:0;width:70px;height:70px;transform:translate(-50%,-7px);border-radius:50%;
      background:radial-gradient(circle,#34d39933 0%,transparent 62%);opacity:.35;transition:opacity .6s;pointer-events:none}
    .tw-node.tw-work .tw-halo{opacity:1;animation:tw-halo 1.8s ease-in-out infinite}
    .tw-node.tw-verify .tw-halo{background:radial-gradient(circle,#fbbf2433 0%,transparent 62%);opacity:1;animation:tw-halo 1.3s infinite}
    .tw-node.tw-blocked .tw-halo{background:radial-gradient(circle,#f8717133 0%,transparent 62%);opacity:1;animation:tw-halo .55s infinite}
    .tw-robot{position:relative;width:54px;height:54px;margin:0 auto;animation:tw-bob 3.6s ease-in-out infinite;
      filter:drop-shadow(0 8px 11px #000a);transition:filter .5s}
    .tw-robot svg{display:block;width:54px;height:54px;overflow:visible}
    .tw-node.tw-work .tw-robot{filter:drop-shadow(0 0 13px #34d39955) drop-shadow(0 8px 11px #000a)}
    .tw-node.tw-verify .tw-robot{filter:drop-shadow(0 0 14px #fbbf2455) drop-shadow(0 8px 11px #000a)}
    .tw-node.tw-blocked .tw-robot{animation:tw-shake .34s infinite;filter:drop-shadow(0 0 15px #f8717199)}
    .tw-name{font-size:9.5px;letter-spacing:.5px;color:#9aafd6;margin-top:4px;transition:color .4s}
    .tw-state{font-size:8.5px;color:#5f7398;margin-top:1px;transition:color .4s}
    .tw-node.tw-work .tw-name{color:#eaf7ff}
    .tw-node.tw-work .tw-state{color:#6ee7b7}
    .tw-node.tw-verify .tw-state{color:#fcd34d}
    .tw-node.tw-blocked .tw-state{color:#fca5a5}
    .tw-node.tw-done .tw-state{color:#67e8f9}
    .tw-detail{position:absolute;left:8px;right:8px;bottom:6px;border-radius:12px;border:1px solid #28446f;
      background:#0a1425f2;padding:9px 11px;z-index:5;box-shadow:0 12px 30px #000b}
    .tw-detail-title{font-size:11px;color:#d9ecff;font-weight:600}
    .tw-detail-body{font-size:10px;color:#8ea3c9;margin-top:4px;line-height:1.5}
    .tw-detail-hint{font-size:9px;color:#5f7398;margin-top:4px}
    .tw-legend{display:flex;gap:10px;padding:0 12px 6px;font-size:9px;color:#5f7398}
    .tw-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;vertical-align:middle;box-shadow:0 0 8px currentColor}
    .tw-dot-work{background:#34d399;color:#34d399}.tw-dot-verify{background:#fbbf24;color:#fbbf24}
    .tw-dot-idle{background:#5f7398;color:#5f7398}.tw-dot-blocked{background:#f87171;color:#f87171}
    .tw-ticker{border-top:1px solid #1a2947;padding:7px 12px 9px;background:#060b15f2}
    .tw-ticker-title{font-size:9px;letter-spacing:1.5px;color:#607396;margin-bottom:4px}
    .tw-ticker-line{font-size:10px;color:#8ea3c9;line-height:1.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tw-ticker-line b{color:#cfe9ff}
    @keyframes tw-pulse{0%{box-shadow:0 0 0 0 #34d39999}70%{box-shadow:0 0 0 9px #34d39900}100%{box-shadow:0 0 0 0 #34d39900}}
    @keyframes tw-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
    @keyframes tw-dash{to{stroke-dashoffset:-30}}
    @keyframes tw-shake{0%,100%{transform:translate(0,0)}20%{transform:translate(-1.5px,1px)}80%{transform:translate(1.5px,-1px)}}
    @keyframes tw-halo{0%,100%{transform:translate(-50%,-7px) scale(.92);opacity:.55}50%{transform:translate(-50%,-7px) scale(1.08);opacity:1}}
    .eye{animation:tw-blink 4.2s infinite}
    @keyframes tw-blink{0%,92%,100%{opacity:1}95%{opacity:.08}}
    .arm{transform-origin:36px 32px;animation:tw-arm 1.5s ease-in-out infinite}
    @keyframes tw-arm{0%,100%{transform:rotate(0)}50%{transform:rotate(-20deg)}}
    .scan{animation:tw-scan 1.5s infinite}
    @keyframes tw-scan{0%,100%{transform:translateY(-1px);opacity:.15}50%{transform:translateY(9px);opacity:1}}
    .chest{animation:tw-chest 2.2s ease-in-out infinite}
    @keyframes tw-chest{0%,100%{opacity:.55}50%{opacity:1}}
    @media (prefers-reduced-motion: reduce){
      .tw-robot,.tw-halo,.eye,.arm,.scan,.chest,.tw-live-dot{animation:none!important}
    }
    `;

    const ROLES = {
      sentinel: { name: '门卫', duty: '检查宪章是否够格开工', color: '#f87171', eye: '#fecaca', dark: '#351726', light: '#5b2333', extra: 'shield' },
      orch: { name: '包工头', duty: '拆里程碑、分文件、派活', color: '#60a5fa', eye: '#dbeafe', dark: '#102442', light: '#1d3d6b', extra: 'arm' },
      explorer: { name: '侦察', duty: '只读摸清代码地形', color: '#2dd4bf', eye: '#ccfbf1', dark: '#0c2327', light: '#154249', extra: 'lens' },
      critic: { name: '找茬', duty: '专挑实现缺陷', color: '#f472b6', eye: '#fce7f3', dark: '#2b1224', light: '#4d2039', extra: 'scan' },
      test: { name: '测试员', duty: '独立写测试，不改生产代码', color: '#818cf8', eye: '#e0e7ff', dark: '#171a36', light: '#2b2f5e', extra: 'flask' },
      challenger: { name: '红队', duty: '攻击方案前提与测量方法', color: '#facc15', eye: '#fef9c3', dark: '#2a2310', light: '#4a3d14', extra: 'bolt' },
      worker: { name: '工人 ×2', duty: '唯一写业务代码的角色', color: '#f59e0b', eye: '#fef3c7', dark: '#2a2013', light: '#4d3817', extra: 'wrench' },
      spec: { name: '规范矿工', duty: '从 RFC/文档挖权威契约', color: '#a78bfa', eye: '#ede9fe', dark: '#1e1933', light: '#362b5c', extra: 'book' },
      empirical: { name: '混沌红队', duty: 'fuzz / 造反例打实现', color: '#a3e635', eye: '#ecfccb', dark: '#142413', light: '#264018', extra: 'dice' },
      auditor: { name: '复现员', duty: '干净状态重跑证据', color: '#22d3ee', eye: '#cffafe', dark: '#0c222b', light: '#14414f', extra: 'check' },
      success: { name: '终审', duty: '对照原始需求做最终裁决', color: '#fbbf24', eye: '#fef3c7', dark: '#2b2410', light: '#4b3d15', extra: 'crown' },
    };

    const POS = {
      sentinel: [50, 7], orch: [50, 23], explorer: [16, 33], critic: [84, 33],
      test: [16, 52], challenger: [84, 52], worker: [50, 42],
      spec: [16, 71], empirical: [84, 71], auditor: [50, 62], success: [50, 83],
    };

    const LINKS = [
      ['sentinel', 'orch', 'live'],
      ['orch', 'explorer', 'base'], ['orch', 'critic', 'base'], ['orch', 'worker', 'live'],
      ['orch', 'test', 'base'], ['orch', 'challenger', 'base'], ['orch', 'spec', 'base'], ['orch', 'empirical', 'base'],
      ['explorer', 'worker', 'live'], ['test', 'worker', 'base'], ['empirical', 'worker', 'warn'],
      ['worker', 'auditor', 'live'], ['critic', 'auditor', 'base'], ['challenger', 'auditor', 'base'],
      ['auditor', 'success', 'live'],
    ];

    const STATE_TEXT = { idle: '待命', work: '工作中', verify: '审查中', blocked: '被阻塞', done: '已通过' };
    const PHASE_TEXT = {
      scoping: '范围界定', charter: '宪章待批', approved: '已批准', executing: '执行中',
      verifying: '验证中', complete: '已完成', aborted: '已中止',
    };

    const ICONS = {
      shield: '<path d="M14 30H8v8h6M50 30h6v8h-6" fill="none" stroke="#7f1d1d" stroke-width="2"/>',
      arm: '<path class="arm" d="M50 30l9-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
      lens: '<circle cx="45" cy="43" r="5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M48 47l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
      scan: '<path class="scan" d="M24 28h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
      flask: '<path d="M42 40h10v9H42z" fill="none" stroke="currentColor" stroke-width="1.6"/>',
      bolt: '<path d="M40 38l5 7 2-4 4 1-5-8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
      wrench: '<path class="arm" d="M50 34l9 4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M40 42l6 6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
      book: '<path d="M42 40h12v8H42z" fill="none" stroke="currentColor" stroke-width="1.8"/>',
      dice: '<path d="M44 40l4 4-4 4-4-4z" fill="none" stroke="currentColor" stroke-width="1.6"/>',
      check: '<path d="M25 44l4 4 9-10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
      crown: '<path d="M22 16l4-6 6 4 6-4 4 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M28 44l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    };

    function robotInner(id) {
      const r = ROLES[id];
      return `<defs>
        <linearGradient id="tw-body-${id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${r.light}"/><stop offset=".55" stop-color="${r.dark}"/><stop offset="1" stop-color="#050a12"/>
        </linearGradient>
        <linearGradient id="tw-visor-${id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#0b1626"/><stop offset="1" stop-color="#04080f"/>
        </linearGradient>
        <radialGradient id="tw-core-${id}"><stop offset="0" stop-color="${r.eye}" stop-opacity=".95"/><stop offset="1" stop-color="${r.color}" stop-opacity="0"/></radialGradient>
      </defs>
      <ellipse cx="32" cy="55" rx="16" ry="3.4" fill="#000" opacity=".55"/>
      <rect x="13" y="15" width="38" height="34" rx="12" fill="url(#tw-body-${id})" stroke="${r.color}" stroke-width="1.5"/>
      <path d="M18 21 Q32 14 46 21" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="2" stroke-linecap="round"/>
      <rect x="21" y="23" width="22" height="12" rx="6" fill="url(#tw-visor-${id})" stroke="${r.color}" stroke-opacity=".55" stroke-width="1.1"/>
      <path d="M24 25 Q32 22 40 25" fill="none" stroke="#fff" stroke-opacity=".2" stroke-width="1.4" stroke-linecap="round"/>
      <circle class="eye" cx="27" cy="30" r="2.2" fill="${r.eye}"/>
      <circle class="eye" cx="37" cy="30" r="2.2" fill="${r.eye}"/>
      <circle cx="32" cy="44" r="6" fill="url(#tw-core-${id})" class="chest"/>
      <circle cx="32" cy="44" r="2" fill="${r.eye}"/>
      <path d="M32 11v-4" stroke="${r.color}" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="32" cy="5.5" r="2" fill="${r.eye}"/>
      <g style="color:${r.eye}">${ICONS[r.extra] || ''}</g>
      <path d="M13 34c-5 1-6 6-6 10M51 34c5 1 6 6 6 10" fill="none" stroke="${r.color}" stroke-opacity=".45" stroke-width="2" stroke-linecap="round"/>`;
    }

    const IDLE = {
      active: false,
      objective: '当前没有进行中的战役',
      phase: '待命',
      progress: { done: 0, total: 0 },
      robots: {},
      ticker: ['等待战役开始 · 运行 /teamwork 开启一个战役'],
    };

    function pathOf(a, b) {
      const [x1, y1] = POS[a], [x2, y2] = POS[b];
      const ax = x1 * 4, ay = y1 * 5.75, bx = x2 * 4, by = y2 * 5.75;
      const my = (ay + by) / 2;
      return `M${ax} ${ay} C${ax} ${my} ${bx} ${my} ${bx} ${by}`;
    }

    function readCollapsed() {
      try {
        return window.localStorage.getItem('dsh-teamwork:collapsed') === '1';
      } catch {
        return false;
      }
    }

    function saveCollapsed(value) {
      try {
        window.localStorage.setItem('dsh-teamwork:collapsed', value ? '1' : '0');
      } catch {
        // ignore
      }
    }

    function Panel(props) {
      const useSessions = props.useSessions;
      const cwd = useSessions
        ? useSessions((snapshot) => {
            if (!snapshot || !snapshot.byId) return undefined;
            const list = Object.values(snapshot.byId);
            const active = list.find((session) => (session?.retainedBy?.mainView ?? 0) > 0) ?? list[0];
            return active?.cwd;
          })
        : undefined;

      const [data, setData] = useState(IDLE);
      const [collapsed, setCollapsed] = useState(readCollapsed);
      const [selected, setSelected] = useState(undefined);

      useEffect(() => {
        if (!cwd) {
          setData(IDLE);
          return undefined;
        }
        let alive = true;
        let controller;
        const load = async () => {
          try {
            controller?.abort();
            controller = new AbortController();
            const response = await fetch(`/api/teamwork/live?cwd=${encodeURIComponent(cwd)}`, {
              signal: controller.signal,
              headers: { accept: 'application/json' },
            });
            if (!response.ok) return;
            const next = await response.json();
            if (alive && next && next.ok) setData(next);
          } catch {
            // a failed poll keeps the last good state
          }
        };
        load();
        const timer = setInterval(load, 1500);
        return () => {
          alive = false;
          clearInterval(timer);
          controller?.abort();
        };
      }, [cwd]);

      const robots = data.robots || {};
      const stateOf = (id) => robots[id] || 'idle';
      const total = data.progress?.total ?? 0;
      const done = data.progress?.done ?? 0;
      const percent = total > 0 ? Math.round((done / total) * 100) : 0;
      const active = data.active === true;
      const phase = PHASE_TEXT[data.phase] ?? data.phase ?? '待命';

      const toggle = () => {
        const next = !collapsed;
        setCollapsed(next);
        saveCollapsed(next);
      };

      if (collapsed) {
        return h('div', { className: 'tw-root tw-collapsed' },
          h('button', { className: 'tw-pill', onClick: toggle, title: '展开团队实时看板' },
            h('span', { className: 'tw-live-dot' }),
            h('span', { className: 'tw-pill-text' }, '团队'),
            h('span', { className: 'tw-pill-count' }, total > 0 ? `${done}/${total}` : '待命'),
          ),
        );
      }

      return h('div', { className: 'tw-root' },
        h('style', null, CSS),
        h('div', { className: 'tw-panel' },
          h('div', { className: 'tw-head' },
            h('div', { className: 'tw-row1' },
              h('span', { className: 'tw-live-dot' }),
              h('h1', null, '团队协作 · 实时看板'),
              h('span', { className: 'tw-phase' }, phase),
              h('button', { className: 'tw-fold', onClick: toggle, title: '收起' }, '—'),
            ),
            h('div', { className: 'tw-obj' }, data.objective || IDLE.objective),
            h('div', { className: 'tw-progress' },
              h('div', { className: 'tw-bar' }, h('i', { style: { width: `${percent}%` } })),
              h('b', null, total > 0 ? `${done}/${total}` : '—'),
            ),
          ),
          h('div', { className: 'tw-stage' },
            h('svg', { className: 'tw-wires', viewBox: '0 0 400 575', preserveAspectRatio: 'none' },
              LINKS.map(([a, b, kind], index) => h('path', {
                key: `w${index}`,
                d: pathOf(a, b),
                className: `tw-wire tw-wire-${kind}${stateOf(a) !== 'idle' || stateOf(b) !== 'idle' ? ' tw-wire-active' : ''}`,
              })),
            ),
            Object.keys(ROLES).map((id) => {
              const [x, y] = POS[id];
              const state = stateOf(id);
              return h('div', {
                key: id,
                className: `tw-node tw-${state}`,
                style: { left: `${x}%`, top: `${y}%` },
                onClick: () => setSelected(selected === id ? undefined : id),
                title: `${ROLES[id].name} · ${STATE_TEXT[state]}`,
              },
                h('div', { className: 'tw-halo' }),
                h('div', { className: 'tw-robot' },
                  h('svg', { viewBox: '0 0 64 64', dangerouslySetInnerHTML: { __html: robotInner(id) } }),
                ),
                h('div', { className: 'tw-name' }, ROLES[id].name),
                h('div', { className: 'tw-state' }, STATE_TEXT[state]),
              );
            }),
            selected && h('div', { className: 'tw-detail' },
              h('div', { className: 'tw-detail-title' }, `${ROLES[selected].name} · ${STATE_TEXT[stateOf(selected)]}`),
              h('div', { className: 'tw-detail-body' }, ROLES[selected].duty),
              h('div', { className: 'tw-detail-hint' }, active ? `战役阶段：${phase}` : '等待战役开始'),
            ),
          ),
          h('div', { className: 'tw-legend' },
            h('span', null, h('i', { className: 'tw-dot tw-dot-work' }), '工作中'),
            h('span', null, h('i', { className: 'tw-dot tw-dot-verify' }), '审查中'),
            h('span', null, h('i', { className: 'tw-dot tw-dot-idle' }), '待命'),
            h('span', null, h('i', { className: 'tw-dot tw-dot-blocked' }), '被阻塞'),
          ),
          h('div', { className: 'tw-ticker' },
            h('div', { className: 'tw-ticker-title' }, '实时事件'),
            (Array.isArray(data.ticker) ? data.ticker : []).slice(0, 4).map((line, index) =>
              h('div', { className: 'tw-ticker-line', key: index }, line),
            ),
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'teamwork-live', order: 40 }, Panel),
        );
      },
    };
  },
});

