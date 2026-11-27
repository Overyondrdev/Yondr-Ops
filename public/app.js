/* Yondr Ops dashboard (ops.overyondrdev.com). Plain JS, no dependencies. */
(function () {
  'use strict';
  var app = document.getElementById('app');
  // Left navigation (admins). 'incidents' is reachable from Overview and Sites & checks (and alert links).
  var VIEWS = [['overview', 'Overview'], ['issues', 'Issues'], ['status', 'Status'], ['checks', 'Sites & checks'], ['errors', 'Errors'], ['deploys', 'Deploys'],
    ['autofix', 'Auto-fixes'], ['backups', 'Backups'], ['people', 'People & permissions'], ['keys', 'Keys'], ['alerts', 'Alerts'], ['settings', 'Settings'], ['audit', 'Audit log']];
  var PRIO = { low: 'Low', normal: 'Normal', high: 'High', critical: 'Critical' };
  var ISSUE_ST = { open: 'Open', in_progress: 'In progress', blocked: 'Blocked', resolved: 'Resolved', wont_fix: 'Won\'t fix' };
  var SOURCES = { manual: 'Manual', incident: 'Incident', feedback: 'Feedback', autofix: 'Auto-fix', deploy: 'Deploy', security: 'Security' };
  var SEV = { info: 'Info', warning: 'Warning', high: 'High', critical: 'Critical' };
  var AF_STATUS = { queued: 'Queued', triaged: 'Triaged', fixing: 'Fixing', pr_open: 'PR open', checks_failed: 'Checks failed', merged: 'Merged',
    deployed: 'Deployed', verified: 'Verified', failed: 'Failed', reverted: 'Reverted', rejected: 'Rejected' };
  var S = { me: null, view: 'overview', data: {}, drawer: null, afAll: false, issueFilter: { status: 'active' }, directory: null, paused: false, sub: null };

  // ------------------------------------------------------------- helpers
  function api(path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET';
    return fetch('/api/' + path, {
      method: method, credentials: 'same-origin',
      // Every change carries X-Yondr-Ops: 1 (the API's CSRF check).
      headers: Object.assign(opts.body ? { 'content-type': 'application/json' } : {}, method !== 'GET' ? { 'x-yondr-ops': '1' } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.error || 'Request failed'); e.status = r.status; throw e; } return d; });
    });
  }
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v; else if (k === 'checked') e.checked = !!v;
      else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
    });
    (kids || []).forEach(function (c) { if (c != null && c !== false) e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c); });
    return e;
  }
  function when(iso) { return iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function ago(iso) {
    if (!iso) return 'never';
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' days ago';
  }
  function dur(sec) { if (sec == null) return ''; if (sec < 3600) return Math.max(1, Math.round(sec / 60)) + ' min'; if (sec < 172800) return Math.round(sec / 360) / 10 + ' h'; return Math.round(sec / 86400) + ' days'; }
  function size(b) { if (b == null) return '—'; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KiB'; return (b / 1048576).toFixed(1) + ' MiB'; }
  function sevPill(s) { return s ? h('span', { class: 'pill sev-' + s, text: SEV[s] || s }) : null; }
  function pill(text, cls) { return h('span', { class: 'pill ' + (cls || 'st-neutral'), text: text }); }
  function toast(msg) {
    var t = h('div', { class: 'toast', role: 'status', text: msg });
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 4000);
  }
  function btn(label, onclick, cls, attrs) { return h('button', Object.assign({ type: 'button', class: 'btn ' + (cls || ''), onclick: onclick }, attrs || {}), [label]); }
  function isOwner() { return S.me && S.me.role === 'owner'; }
  function fail(er) { toast(er.message || 'Something went wrong'); }

  // A modal dialog (native <dialog>: focus is trapped and Escape closes it). onok returns a promise or false.
  function dialog(title, body, okLabel, onok, danger) {
    var d = h('dialog', { 'aria-labelledby': 'dlg-title' });
    var ok = btn(okLabel, function () {
      var r = onok();
      if (r === false) return;
      ok.disabled = true;
      Promise.resolve(r).then(function () { d.close(); }).catch(function (er) { ok.disabled = false; fail(er); });
    }, danger ? 'danger' : 'primary');
    d.appendChild(h('h2', { id: 'dlg-title', text: title }));
    d.appendChild(body);
    d.appendChild(h('div', { class: 'actions' }, [btn('Cancel', function () { d.close(); }), ok]));
    d.addEventListener('close', function () { d.remove(); });
    document.body.appendChild(d);
    d.showModal();
    return d;
  }

  // ------------------------------------------------------------- shell
  function go(view) { S.view = view; S.sub = null; history.replaceState(null, '', '#' + view); load().then(function () { var m = document.getElementById('main'); if (m) m.focus(); }); }
  function isStaff() { return S.me && !S.me.role; }
  function shell(content) {
    var items = isStaff() ? [['status', 'Status']] : VIEWS;
    var nav = h('nav', { class: 'nav', id: 'nav', 'aria-label': 'Sections' }, items.map(function (v) {
      return h('a', { href: '#' + v[0], 'aria-current': S.view === v[0] ? 'page' : false, onclick: function (e) { e.preventDefault(); side.classList.remove('open'); menu.setAttribute('aria-expanded', 'false'); go(v[0]); } }, [v[1]]);
    }));
    var menu = h('button', { type: 'button', class: 'btn menu', 'aria-expanded': 'false', 'aria-controls': 'nav', onclick: function () {
      var open = !side.classList.contains('open'); side.classList.toggle('open', open); menu.setAttribute('aria-expanded', String(open));
    } }, ['Menu']);
    var side = h('aside', { class: 'side' + (isStaff() ? ' staff' : '') }, [
      h('div', { class: 'top' }, [h('a', { class: 'brand', href: isStaff() ? '#status' : '#overview' }, [h('img', { src: '/brand/yondr-lichen.svg', alt: 'Yondr' }), h('span', { text: 'Ops' })]), isStaff() ? null : menu]),
      nav, h('div', { class: 'spacer' }),
      h('div', { class: 'me' }, [h('b', { text: S.me.email }), h('span', { text: S.me.role === 'owner' ? 'Owner' : S.me.role === 'admin' ? 'Admin' : 'Staff' }),
        h('a', { href: 'https://auth.overyondrdev.com/logout?return=' + encodeURIComponent(location.origin + '/') }, ['Sign out'])]),
    ]);
    var skip = h('a', { class: 'skip', href: '#main', onclick: function (e) { e.preventDefault(); document.getElementById('main').focus(); } }, ['Skip to content']);
    var main = h('main', { class: 'main', id: 'main', tabindex: '-1' }, [content]);
    app.replaceChildren(skip, h('div', { class: 'app' }, [side, main]));
  }
  function head(title, sub, actions) {
    return h('div', { class: 'page-head' }, [h('div', {}, [h('h1', { text: title }), sub ? h('p', { text: sub }) : null]), actions ? h('div', { class: 'inline' }, actions) : null]);
  }
  function loading() { shell(h('div', { class: 'spinner', role: 'status', 'aria-label': 'Loading' })); }

  // ------------------------------------------------------------- Status
  function dotFor(c) {
    var s = c.state;
    if (!s || s.status === 'unknown') return 'grey';
    if (s.status === 'ok') return 'green';
    return s.severity === 'warning' || s.severity === 'info' ? 'amber' : 'red';
  }
  function viewChecks(d) {
    var checks = d.checks;
    var failing = checks.filter(function (c) { return c.state && c.state.status === 'fail'; });
    var ok = checks.filter(function (c) { return c.state && c.state.status === 'ok'; });
    var parts = [head('Sites & checks', 'Every site and setting ops watches. Checks run every 5 minutes.', [
      h('a', { class: 'btn', href: '#incidents' }, ['Incidents']),
      btn('Run checks now', function (e) { e.target.disabled = true; api('checks/run', { method: 'POST' }).then(function () { toast('Checks finished'); load(); }).catch(function (er) { e.target.disabled = false; fail(er); }); }, 'primary'),
    ])];
    var off = Object.keys(d.switches).filter(function (k) { return k !== 'autofix_enabled' && !d.switches[k]; });
    if (off.length) parts.push(h('div', { class: 'banner red', role: 'alert', text: 'Switched off: ' + off.map(function (k) { return k.replace('_enabled', ''); }).join(', ') + '. See Settings.' }));
    if (!d.cloudflare_token) parts.push(h('div', { class: 'banner', text: 'The Cloudflare API token (CF_API_TOKEN) is not set, so deploy, Access, inventory and usage checks are skipped.' }));
    parts.push(h('div', { class: 'grid kpis' }, [
      kpi(failing.length, 'Problems now', failing.length > 0), kpi(ok.length + ' / ' + checks.length, 'Checks passing'),
      kpi(d.open_incidents, 'Open incidents'), kpi(d.last_monitor ? ago(d.last_monitor.started_at) : 'never', 'Last check'),
    ]));
    var groups = [['gate', 'Sites (signed-out visit)'], ['public', 'overyondr.com'], ['errors', 'Server errors (last 15 minutes)'], ['deploy', 'Deploys'], ['cloudflare', 'Cloudflare setup'], ['usage', 'Usage today']];
    groups.forEach(function (g) {
      var list = checks.filter(function (c) { return c.kind === g[0]; });
      if (!list.length) return;
      parts.push(h('h2', { class: 'group', text: g[1] }));
      parts.push(h('div', { class: 'list' }, list.map(checkRow)));
    });
    return h('div', {}, parts);
  }
  function kpi(v, k, accent) { return h('div', { class: 'card kpi' + (accent ? ' accent' : '') }, [h('div', { class: 'v', text: String(v) }), h('div', { class: 'k', text: k })]); }
  function checkRow(c) {
    var s = c.state || {};
    var color = dotFor(c);
    var label = { green: 'OK', amber: 'Warning', red: 'Problem', grey: 'Not checked' }[color];
    return h('div', { class: 'row' }, [
      h('span', { class: 'dot ' + color, role: 'img', 'aria-label': label }),
      h('div', {}, [
        h('div', { class: 't' }, [c.site || c.id, ' ', s.status === 'fail' ? sevPill(s.severity) : null, c.mute ? pill('Muted until ' + when(c.mute.until)) : null]),
        s.title && s.status === 'fail' ? h('div', { class: 'd', text: s.title }) : null,
        s.detail ? h('div', { class: 'd small muted', text: s.detail }) : null,
        h('div', { class: 'm' }, [h('span', { text: s.since ? (s.status === 'fail' ? 'Failing since ' : 'Fine since ') + when(s.since) : 'Not run yet' }),
          h('span', { text: 'Checked ' + ago(s.last_run) }), c.mute ? h('span', { text: 'Muted by ' + c.mute.created_by + ': ' + c.mute.reason }) : null]),
      ]),
      h('div', { class: 'act' }, [c.mute ? btn('Unmute', function () { api('checks/' + encodeURIComponent(c.id) + '/mute', { method: 'DELETE' }).then(function () { toast('Unmuted'); load(); }).catch(fail); })
        : btn('Mute', function () { muteDialog(c); })]),
    ]);
  }
  function muteDialog(c) {
    var hours = h('select', { class: 'input', id: 'mute-hours' }, [1, 2, 4, 8, 24, 48, 72, 168].map(function (n) { return h('option', { value: String(n), text: n < 24 ? n + ' hours' : n / 24 + ' days' }); }));
    hours.value = '4';
    var reason = h('input', { class: 'input', id: 'mute-reason', maxlength: '200', placeholder: 'e.g. planned maintenance on the ad library' });
    dialog('Mute "' + (c.site || c.id) + '"', h('div', { class: 'form' }, [
      h('p', { class: 'muted', text: 'The check keeps running and incidents are still logged, but nobody is alerted. If it is still failing when the mute ends, people are told then.' }),
      h('div', { class: 'field' }, [h('label', { for: 'mute-hours', text: 'For' }), hours]),
      h('div', { class: 'field' }, [h('label', { for: 'mute-reason', text: 'Why (logged)' }), reason]),
    ]), 'Mute', function () {
      if (!reason.value.trim()) { reason.focus(); toast('Say why'); return false; }
      return api('checks/' + encodeURIComponent(c.id) + '/mute', { method: 'POST', body: { hours: Number(hours.value), reason: reason.value } }).then(function () { toast('Muted'); load(); });
    });
  }

  // ------------------------------------------------------------- Incidents
  function viewIncidents(d) {
    var rows = d.incidents.map(function (i) {
      return h('div', { class: 'row' }, [
        h('span', { class: 'dot ' + (i.resolved_at ? 'green' : i.severity === 'warning' || i.severity === 'info' ? 'amber' : 'red'), role: 'img', 'aria-label': i.resolved_at ? 'Resolved' : 'Open' }),
        h('div', {}, [h('div', { class: 't' }, [i.title, ' ', sevPill(i.severity)]), i.detail ? h('div', { class: 'd small', text: i.detail }) : null,
          h('div', { class: 'm' }, [h('span', { text: (i.site || i.check_id) }), h('span', { text: 'Opened ' + when(i.opened_at) }),
            h('span', { text: i.resolved_at ? 'Resolved ' + when(i.resolved_at) + ' (' + dur(i.duration_s) + ')' : 'Still open' }),
            h('span', { text: i.alerted ? 'People were alerted' : 'No alert sent (muted or switched off)' }),
            i.issue_id ? h('a', { href: '#issues/' + i.issue_id }, ['Issue #' + i.issue_id]) : null])]),
        h('div', { class: 'act' }, [pill(i.resolved_at ? 'Resolved' : 'Open', i.resolved_at ? 'st-ok' : 'st-fail')]),
      ]);
    });
    var mutes = d.mutes.map(function (m) { return h('tr', {}, [h('td', { text: m.check_id }), h('td', { text: when(m.created_at) }), h('td', { text: when(m.ended_at || m.until) }), h('td', { text: m.created_by }), h('td', { text: m.reason })]); });
    return h('div', {}, [head('Incidents', 'Every time a check started failing, and when it was fixed.'),
      rows.length ? h('div', { class: 'list' }, rows) : h('div', { class: 'empty', text: 'No incidents yet.' }),
      h('h2', { class: 'group', text: 'Mutes' }),
      mutes.length ? h('div', { class: 'tablewrap' }, [h('table', {}, [h('thead', {}, [h('tr', {}, ['Check', 'From', 'Until', 'By', 'Why'].map(function (t) { return h('th', { scope: 'col', text: t }); }))]), h('tbody', {}, mutes)])])
        : h('p', { class: 'muted', text: 'No checks have been muted.' })]);
  }

  // ------------------------------------------------------------- Alerts: people & rules
  function viewAlerts(d) {
    var p = d.people;
    var email = h('input', { class: 'input', id: 'add-email', type: 'email', autocomplete: 'off', placeholder: 'name@overyondr.com' });
    var name = h('input', { class: 'input', id: 'add-name', autocomplete: 'off', placeholder: 'Their name' });
    var add = h('form', { class: 'card', onsubmit: function (e) {
      e.preventDefault();
      api('people', { method: 'POST', body: { email: email.value, name: name.value } }).then(function (r) { toast('Added. Choose their alerts.'); return load().then(function () { openPerson(r.id); }); }).catch(fail);
    } }, [h('h2', { text: 'Add a person' }), h('div', { class: 'inline' }, [
      h('div', { class: 'field' }, [h('label', { for: 'add-email', text: 'Work email' }), email]),
      h('div', { class: 'field' }, [h('label', { for: 'add-name', text: 'Name' }), name]),
      h('button', { type: 'submit', class: 'btn primary' }, ['Add']),
    ]), h('p', { class: 'small muted', text: 'New people get the usual alerts by email (site down/exposed, failed deploys and backups, auto-fix problems, critical feedback, daily digest). You can change that next.' })]);
    var list = p.people.map(function (s) {
      var n = s.rules.filter(function (r) { return r.channel === 'email'; }).length;
      var k = s.rules.filter(function (r) { return r.channel === 'slack'; }).length;
      return h('button', { type: 'button', class: 'row click', onclick: function () { openPerson(s.id); } }, [
        h('span', { class: 'dot ' + (s.active ? 'green' : 'grey'), role: 'img', 'aria-label': s.active ? 'Active' : 'Paused' }),
        h('div', {}, [h('div', { class: 't' }, [s.name || s.email, s.owner ? h('span', { class: 'locked', text: 'Owner' }) : null]),
          h('div', { class: 'm' }, [h('span', { text: s.email }), h('span', { text: p.min_severity[s.min_severity] }),
            h('span', { text: n + ' email rule' + (n === 1 ? '' : 's') + (k ? ', ' + k + ' Slack' : '') }),
            s.quiet_start ? h('span', { text: 'Quiet ' + s.quiet_start + '–' + s.quiet_end + ' ' + s.timezone }) : null, s.active ? null : h('span', { text: 'Paused' })])]),
        h('div', { class: 'act' }, [h('span', { class: 'btn', text: 'Edit' })]),
      ]);
    });
    var log = d.log.alerts.map(function (a) {
      return h('tr', {}, [h('td', { text: when(a.created_at) }), h('td', { text: a.subject }), h('td', { text: a.channel }), h('td', { text: a.recipients.join(', ') }),
        h('td', {}, [pill(a.status, 'st-' + a.status)]), h('td', { class: 'small', text: a.error || '' })]);
    });
    return h('div', {}, [head('Alerts', 'Who is told about what, and how. Owners always get "site down" and "site exposed" by email.'),
      add,
      h('h2', { class: 'group', text: 'People' }),
      list.length ? h('div', { class: 'list' }, list) : h('div', { class: 'empty', text: 'Nobody yet. Owners still get site down / exposed alerts.' }),
      h('h2', { class: 'group', text: 'Alert types' }),
      h('div', { class: 'tablewrap' }, [h('table', {}, [h('thead', {}, [h('tr', {}, ['Type', 'Usual severity', 'What it means'].map(function (t) { return h('th', { scope: 'col', text: t }); }))]),
        h('tbody', {}, p.events.map(function (e) { return h('tr', {}, [h('td', {}, [e.label, e.ownerForced ? h('span', { class: 'locked', text: 'Owners always' }) : null]), h('td', {}, [sevPill(e.severity)]), h('td', { text: e.help })]); }))])]),
      h('h2', { class: 'group', text: 'Recently sent' }),
      log.length ? h('div', { class: 'tablewrap' }, [h('table', {}, [h('thead', {}, [h('tr', {}, ['When', 'Alert', 'Channel', 'To', 'Status', 'Error'].map(function (t) { return h('th', { scope: 'col', text: t }); }))]), h('tbody', {}, log)])])
        : h('p', { class: 'muted', text: 'No alerts sent yet.' })]);
  }

  function openPerson(id) {
    var p = S.data.people;
    var s = p.people.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    var has = function (t, ch, hook) { return s.rules.some(function (r) { return r.event_type === t && r.channel === ch && (ch !== 'slack' || r.webhook === hook); }); };
    var slackOf = function (t) { var r = s.rules.filter(function (r) { return r.event_type === t && r.channel === 'slack'; })[0]; return r ? r.webhook : ''; };
    var nameI = h('input', { class: 'input', id: 'p-name', value: s.name || '' });
    var sev = h('select', { class: 'input', id: 'p-sev' }, Object.keys(p.min_severity).map(function (k) { return h('option', { value: k, text: p.min_severity[k] }); }));
    sev.value = s.min_severity;
    var qs = h('input', { class: 'input', id: 'p-qs', type: 'time', value: s.quiet_start || '' });
    var qe = h('input', { class: 'input', id: 'p-qe', type: 'time', value: s.quiet_end || '' });
    var tz = h('input', { class: 'input', id: 'p-tz', value: s.timezone || 'UTC', list: 'tzs', autocomplete: 'off' });
    var tzs = h('datalist', { id: 'tzs' }, ['UTC', 'Europe/London', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/Amsterdam'].map(function (z) { return h('option', { value: z }); }));
    var active = h('input', { type: 'checkbox', id: 'p-active', checked: !!s.active });
    var rows = p.events.filter(function (e) { return !e.personal; }).map(function (e) {
      var forced = s.owner && e.ownerForced;
      var em = h('input', { type: 'checkbox', 'data-ev': e.type, 'aria-label': e.label + ' by email', checked: forced || has(e.type, 'email'), disabled: forced });
      var sl = h('select', { class: 'input', 'data-ev': e.type, 'aria-label': e.label + ' to Slack' }, [h('option', { value: '', text: 'No Slack' })].concat(p.webhooks.map(function (w) { return h('option', { value: w, text: w.replace('SLACK_WEBHOOK_', '#').toLowerCase() }); })));
      sl.value = slackOf(e.type);
      if (!p.webhooks.length) sl.disabled = true;
      return { e: e, em: em, sl: sl, forced: forced, tr: h('tr', {}, [
        h('td', {}, [h('b', { text: e.label }), forced ? h('span', { class: 'locked', text: 'Always on for owners' }) : null, h('span', { class: 'help', text: e.help })]),
        h('td', {}, [sevPill(e.severity)]), h('td', {}, [h('label', { class: 'check' }, [em, h('span', { class: 'sr', text: 'Email' })])]), h('td', {}, [sl]),
      ]) };
    });
    var save = function () {
      var rules = [];
      rows.forEach(function (r) {
        if (r.em.checked && !r.forced) rules.push({ event_type: r.e.type, channel: 'email' });
        if (r.forced) rules.push({ event_type: r.e.type, channel: 'email' });
        if (r.sl.value) rules.push({ event_type: r.e.type, channel: 'slack', webhook: r.sl.value });
      });
      return api('people/' + s.id, { method: 'PATCH', body: { name: nameI.value, min_severity: sev.value, quiet_start: qs.value || null, quiet_end: qe.value || null, timezone: tz.value || 'UTC', active: active.checked, rules: rules } })
        .then(function () { toast('Saved'); closeDrawer(); load(); }).catch(fail);
    };
    var content = h('div', { class: 'form' }, [
      h('dl', { class: 'kv' }, [h('dt', { text: 'Email' }), h('dd', { text: s.email }), h('dt', { text: 'Added by' }), h('dd', { text: s.created_by + ', ' + when(s.created_at) })]),
      h('div', { class: 'inline' }, [h('div', { class: 'field' }, [h('label', { for: 'p-name', text: 'Name' }), nameI]),
        h('div', { class: 'field' }, [h('label', { for: 'p-sev', text: 'Send them' }), sev])]),
      h('div', { class: 'inline' }, [h('div', { class: 'field' }, [h('label', { for: 'p-qs', text: 'Quiet from' }), qs]), h('div', { class: 'field' }, [h('label', { for: 'p-qe', text: 'Quiet until' }), qe]),
        h('div', { class: 'field' }, [h('label', { for: 'p-tz', text: 'Time zone' }), tz, tzs])]),
      h('p', { class: 'small muted', text: 'During quiet hours only critical alerts are sent. Leave both times empty for no quiet hours.' }),
      h('label', { class: 'check' }, [active, 'Active (untick to pause all their alerts; owners still get site down / exposed and auto-fix spending)']),
      h('div', { class: 'tablewrap' }, [h('table', { class: 'rules' }, [h('thead', {}, [h('tr', {}, ['Alert', 'Severity', 'Email', 'Slack'].map(function (t) { return h('th', { scope: 'col', text: t }); }))]),
        h('tbody', {}, rows.map(function (r) { return r.tr; }))])]),
      !p.webhooks.length ? h('p', { class: 'small muted', text: 'No Slack webhooks are configured yet (secrets named SLACK_WEBHOOK_…; see README).' }) : null,
      h('div', { class: 'inline' }, [btn('Save', save, 'primary'),
        btn('Send test alert', function (e) { e.target.disabled = true; api('alerts/test', { method: 'POST', body: { id: s.id } }).then(function (r) { toast('Test sent (' + r.sent + ')'); }).catch(fail).then(function () { e.target.disabled = false; }); }),
        btn('Remove', function () {
          dialog('Remove ' + (s.name || s.email) + '?', h('p', { text: 'They stop getting alerts from ops. ' + (s.owner ? 'As an owner they still get site down / exposed alerts.' : '') }), 'Remove', function () {
            return api('people/' + s.id, { method: 'DELETE' }).then(function () { toast('Removed'); closeDrawer(); load(); });
          }, true);
        }, 'danger')]),
    ]);
    openDrawer(s.name || s.email, content);
  }

  // ------------------------------------------------------------- Backups
  function viewBackups(d) {
    var rows = d.backups.map(function (b) {
      var canDownload = b.status === 'ok' && !b.deleted_at && (!b.pii || isOwner());
      return h('tr', {}, [h('td', { text: b.day }), h('td', {}, [b.db, b.pii ? h('span', { class: 'locked', text: 'Personal data' }) : null]),
        h('td', {}, [pill(b.deleted_at ? 'deleted' : b.status, b.deleted_at ? 'st-skipped' : 'st-' + b.status)]),
        h('td', { class: 'num', text: size(b.bytes) }), h('td', { class: 'num', text: b.tables == null ? '—' : String(b.tables) }), h('td', { class: 'num', text: b.rows == null ? '—' : String(b.rows) }),
        h('td', { class: 'num', text: b.duration_ms == null ? '—' : (b.duration_ms / 1000).toFixed(1) + ' s' }),
        h('td', {}, [canDownload ? h('a', { class: 'btn', href: '/api/backups/' + b.id + '/download', download: '' }, ['Download']) : h('span', { class: 'small muted', text: b.error || (b.pii && !b.deleted_at && b.status === 'ok' ? 'Owners only' : '') })])]);
    });
    return h('div', {}, [head('Backups', 'Every database is copied to R2 every night at 03:17 UTC.', [
      btn('Back up now', function (e) { e.target.disabled = true; api('backups/run', { method: 'POST' }).then(function () { toast('Backup started. Refresh in a minute.'); }).catch(function (er) { e.target.disabled = false; fail(er); }); }, 'primary')]),
      !d.bucket ? h('div', { class: 'banner red', text: 'The R2 bucket binding (BACKUPS) is missing.' }) : null,
      h('div', { class: 'grid three' }, d.databases.map(function (db) { return h('div', { class: 'card' }, [h('b', { text: db.name }), h('div', { class: 'small muted', text: (db.bound ? 'Connected' : 'Not connected') + (db.pii ? ' · personal data: shorter retention, owners-only download' : '') })]); })),
      h('h2', { class: 'group', text: 'History' }),
      rows.length ? h('div', { class: 'tablewrap' }, [h('table', {}, [h('thead', {}, [h('tr', {}, ['Day', 'Database', 'Status', 'Size', 'Tables', 'Rows', 'Took', ''].map(function (t) { return h('th', { scope: 'col', text: t }); }))]), h('tbody', {}, rows)])])
        : h('div', { class: 'empty', text: 'No backups yet.' }),
      h('h2', { class: 'group', text: 'Restoring' }),
      h('div', { class: 'card' }, [h('p', { text: 'A backup is a gzip\'d SQL file. To restore, a developer unzips it and loads it into an EMPTY database (never over live data without the owner\'s say-so):' }),
        h('pre', { class: 'code', text: 'gunzip yondr-feedback-2026-11-27.sql.gz\nnpx wrangler d1 create yondr-feedback-restore\nnpx wrangler d1 execute yondr-feedback-restore --remote --file=yondr-feedback-2026-11-27.sql' }),
        h('p', { class: 'small muted', text: 'Full procedure, including swapping a restored database in: README "Restore".' })])]);
  }

  // ------------------------------------------------------------- Auto-fixes
  function afPill(s) { return pill(AF_STATUS[s] || s, s === 'failed' || s === 'checks_failed' ? 'st-fail' : s === 'merged' || s === 'deployed' || s === 'verified' ? 'st-ok' : s === 'reverted' || s === 'rejected' ? 'st-skipped' : 'st-neutral'); }
  function viewAutofix(d) {
    var rows = d.autofixes.map(function (a) {
      return h('button', { type: 'button', class: 'row click', onclick: function () { openAutofix(a.id); } }, [
        h('span', { class: 'dot ' + (a.status === 'failed' || a.status === 'checks_failed' ? 'red' : a.status === 'reverted' ? 'amber' : 'green'), 'aria-hidden': 'true' }),
        h('div', {}, [h('div', { class: 't', text: '#' + a.id + ' ' + a.title }), h('div', { class: 'm' }, [h('span', { text: a.repo.replace('Overyondrdev/', '') }),
          a.classification ? h('span', { text: a.classification }) : null, a.feedback_id ? h('span', { text: 'Feedback #' + a.feedback_id }) : null, h('span', { text: 'Updated ' + ago(a.updated_at) })])]),
        h('div', { class: 'act' }, [afPill(a.status)]),
      ]);
    });
    var c = d.config;
    var banner = c.reason === 'budget'
      ? h('div', { class: 'banner red', role: 'alert', text: 'Auto-fix is paused: this month\'s spend reached the pause level (' + money(c.budget.pause_at) + '). Bugs are triaged and queued, nothing starts until an owner approves more spend (Spend, below). Reverting still works.' })
      : h('div', { class: 'banner' + (c.autofix_enabled ? '' : ' red'), text: c.autofix_enabled ? 'The auto-fix engine is allowed to work (Settings): up to ' + c.autofix_max_per_hour + ' queued fixes an hour, critical ones straight away.' : 'The auto-fix engine is switched off (Settings): bugs are triaged and queued, nothing starts. Reverting still works.' });
    var all = h('input', { type: 'checkbox', id: 'af-all', checked: S.afAll, onchange: function () { S.afAll = all.checked; load(); } });
    return h('div', {}, [head('Auto-fixes', 'Every feedback item the feedback tool reports is triaged here. Only objective bugs are fixed automatically (critical ones straight away, the others queued); subjective ones wait for a person. Every step is logged, and any merged fix can be reverted with one click.'),
      banner,
      h('p', {}, [all, h('label', { for: 'af-all', text: ' Also show items that are not bugs (rejected)' })]),
      rows.length ? h('div', { class: 'list' }, rows) : h('div', { class: 'empty', text: 'Nothing here yet. Feedback appears once the feedback tool reports it.' }),
      spendPanel(d.spend)]);
  }

  // Spend: this month's Claude API cost of auto-fix (README "Auto-fix → Spending").
  function money(n) { return '$' + (Number(n) || 0).toFixed(2); }
  function spendPanel(sp) {
    if (!sp) return null;
    var b = sp.budget;
    var month = new Date(b.month + '-01T00:00:00Z').toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    var costs = sp.costs.map(function (x) {
      return h('tr', {}, [h('td', { text: when(x.run_at) }), h('td', {}, [h('a', { href: '#autofix/' + x.autofix_id, onclick: function (e) { e.preventDefault(); openAutofix(x.autofix_id); } }, ['#' + x.autofix_id + ' ' + (x.title || '')])]),
        h('td', { text: x.unknown ? money(x.counted_usd) + ' (cost unknown, counted as ' + money(sp.limits.unknown_run_usd) + ')' : money(x.cost_usd) })]);
    });
    var approvals = sp.approvals.map(function (a) { return h('li', { text: '+' + money(a.approved_extra_usd) + ' by ' + a.approved_by + ', ' + when(a.approved_at) }); });
    return h('section', { id: 'spend', 'aria-labelledby': 'spend-title' }, [
      h('h2', { class: 'group', id: 'spend-title', text: 'Spend (' + month + ', Claude API)' }),
      b.paused ? h('div', { class: 'banner red', role: 'alert', text: 'Paused: ' + money(b.spent) + ' spent, the pause level is ' + money(b.pause_at) + '.' }) : null,
      h('div', { class: 'grid kpis' }, [kpi(money(b.spent), 'Spent this month', b.paused), kpi(money(b.forecast), 'Forecast for the month', b.over_forecast),
        kpi(money(b.effective), b.approved_extra ? 'Budget (incl. ' + money(b.approved_extra) + ' approved)' : 'Budget'), kpi(money(b.pause_at), 'Pauses at')]),
      h('p', { class: 'small muted', text: 'Forecast = spend so far ÷ days elapsed (at least 3) × days in the month, plus ' + money(2) + ' for each fix waiting or in progress (' + (b.queued + b.running) + ' now). Owners are warned at ' + b.warnings.map(function (w) { return w.pct + ' % (' + money(w.at) + ')'; }).join(' and ') + ', when the forecast is over budget, and when auto-fix pauses. A run whose cost could not be read counts as ' + money(sp.limits.unknown_run_usd) + '.' }),
      approveControl(sp),
      approvals.length ? h('div', {}, [h('h3', { class: 'group', text: 'Approved this month' }), h('ul', {}, approvals)]) : null,
      h('h3', { class: 'group', text: 'Cost per fix this month' }),
      costs.length ? h('div', { class: 'tablewrap' }, [h('table', {}, [h('thead', {}, [h('tr', {}, ['When', 'Fix', 'Cost'].map(function (t) { return h('th', { scope: 'col', text: t }); }))]), h('tbody', {}, costs)])])
        : h('p', { class: 'muted', text: 'No auto-fix runs this month yet.' }),
    ]);
  }
  function approveControl(sp) {
    if (!isOwner()) return h('p', { class: 'small muted', text: 'Only owners can approve more spend.' });
    return h('p', {}, [btn('Approve more spend this month', function () { approveDialog(sp); }, sp.budget.paused ? 'primary' : '')]);
  }
  function approveDialog(sp) {
    var lim = sp.limits;
    var amount = h('input', { class: 'input', id: 'approve-amount', type: 'number', min: '1', max: String(lim.max_approval_usd), step: '1', value: String(lim.default_approval_usd), 'aria-describedby': 'approve-help' });
    dialog('Approve more auto-fix spend?', h('div', { class: 'form' }, [
      h('p', { text: 'This month so far: ' + money(sp.budget.spent) + ' of ' + money(sp.budget.effective) + ' (forecast ' + money(sp.budget.forecast) + '). The extra amount is for this month only; auto-fix pauses again when it is used up.' }),
      h('div', { class: 'field' }, [h('label', { for: 'approve-amount', text: 'Extra amount (US$)' }), amount,
        h('small', { id: 'approve-help', text: 'Whole dollars, 1 to ' + lim.max_approval_usd + ' per approval. If this month\'s total would pass the Claude Console spend limit, raise that limit in Claude Console too.' })]),
    ]), 'Approve', function () {
      var n = Number(amount.value);
      if (!Number.isInteger(n) || n < 1 || n > lim.max_approval_usd) { amount.focus(); toast('Enter a whole number from 1 to ' + lim.max_approval_usd); return false; }
      return api('autofix/budget/approve', { method: 'POST', body: { amount_usd: n } }).then(function (r) { toast('Approved ' + money(n) + ' more for this month'); load(); return r; });
    });
  }
  function openAutofixByFeedback(fid) {
    api('autofix/by-feedback/' + fid).then(function (r) { showAutofix(r.autofix); }).catch(fail);
  }
  function openAutofix(id) { api('autofix/' + id).then(function (r) { showAutofix(r.autofix); }).catch(fail); }
  function classifyButtons(a) {
    if (a.status !== 'queued' && a.status !== 'triaged') return null;
    function mark(c) {
      return function () {
        return api('autofix/' + a.id + '/classify', { method: 'POST', body: { classification: c } })
          .then(function (r) { toast('Marked ' + c + ': ' + (AF_STATUS[r.decision] || r.decision)); load().then(function () { openAutofix(a.id); }); }).catch(fail);
      };
    }
    return h('p', { class: 'links' }, [
      btn('Mark objective', mark('objective'), '', { disabled: a.classification === 'objective' && a.classified_by !== 'ai' ? true : undefined }),
      btn('Mark subjective', mark('subjective'), '', { disabled: a.classification === 'subjective' && a.classified_by !== 'ai' ? true : undefined }),
      h('span', { class: 'small muted', text: ' Objective bugs may be fixed automatically; subjective ones go to a person. Logged with your name.' })]);
  }
  function showAutofix(a) {
    (function () {
      var id = a.id;
      history.replaceState(null, '', '#autofix/' + id);
      var links = [];
      if (a.feedback_id) links.push(h('a', { class: 'btn', href: 'https://feedback.overyondrdev.com/admin#item-' + a.feedback_id, target: '_blank', rel: 'noopener' }, ['Feedback #' + a.feedback_id]));
      if (a.issue_url) links.push(h('a', { class: 'btn', href: a.issue_url, target: '_blank', rel: 'noopener' }, ['Issue']));
      if (a.pr_url) links.push(h('a', { class: 'btn', href: a.pr_url, target: '_blank', rel: 'noopener' }, ['Pull request']));
      if (a.merge_sha) links.push(h('a', { class: 'btn', href: 'https://github.com/' + a.repo + '/commit/' + a.merge_sha, target: '_blank', rel: 'noopener' }, ['Commit ' + a.merge_sha.slice(0, 7)]));
      if (a.revert_pr_url && a.revert_pr_url !== 'pending') links.push(h('a', { class: 'btn', href: a.revert_pr_url, target: '_blank', rel: 'noopener' }, ['Revert PR']));
      var canRevert = ['merged', 'deployed', 'verified'].indexOf(a.status) >= 0 && !a.revert_pr_url;
      var content = h('div', {}, [
        h('div', { class: 'links' }, [afPill(a.status)].concat(links)),
        h('dl', { class: 'kv' }, [h('dt', { text: 'Repository' }), h('dd', { text: a.repo }), h('dt', { text: 'Project' }), h('dd', { text: a.project || '—' }),
          h('dt', { text: 'Classification' }), h('dd', { text: (a.classification || '—') + (a.classified_by ? ' (' + (a.classified_by === 'ai' ? 'Workers AI' : a.classified_by) + ')' : '') + (a.classification_reason ? ': ' + a.classification_reason : '') }),
          a.verify_detail ? h('dt', { text: 'Verification' }) : null, a.verify_detail ? h('dd', { text: a.verify_detail }) : null,
          h('dt', { text: 'Severity' }), h('dd', { text: a.severity || '—' }), h('dt', { text: 'Created' }), h('dd', { text: when(a.created_at) }),
          a.reverted_at ? h('dt', { text: 'Reverted' }) : null, a.reverted_at ? h('dd', { text: when(a.reverted_at) + ' by ' + a.reverted_by }) : null]),
        classifyButtons(a),
        canRevert ? h('p', {}, [btn('Revert this fix', function () { revertDialog(a); }, 'danger')]) : null,
        h('h3', { class: 'group', text: 'Timeline (audit log)' }),
        h('ol', { class: 'timeline' }, a.events.map(function (e) { return h('li', {}, [h('div', {}, [h('div', { text: e.message }), h('div', { class: 'who', text: when(e.created_at) + ' · ' + e.actor + (e.status ? ' · ' + (AF_STATUS[e.status] || e.status) : '') })])]); })),
      ]);
      openDrawer('#' + a.id + ' ' + a.title, content);
    })();
  }
  function revertDialog(a) {
    dialog('Revert "' + a.title + '"?', h('div', {}, [
      h('p', { text: 'Ops opens a pull request in ' + a.repo + ' that puts back every file this fix changed, exactly as it was before. It merges by itself once checks pass (if the repository allows auto-merge), then the site redeploys.' }),
      h('p', { class: 'muted', text: 'If someone changed the same files after this fix, ops refuses and links you to GitHub\'s own Revert button instead.' }),
    ]), 'Open revert pull request', function () {
      return api('autofix/' + a.id + '/revert', { method: 'POST' }).then(function (r) { toast('Revert pull request opened'); closeDrawer(); load().then(function () { openAutofix(a.id); }); return r; })
        .catch(function (er) { closeDrawer(); load().then(function () { openAutofix(a.id); }); throw er; });
    }, true);
  }

  // ------------------------------------------------------------- Settings
  function viewSettings(d) {
    var defs = d.definitions;
    var inputs = {};
    var fields = Object.keys(defs).map(function (k) {
      var def = defs[k]; var v = d.settings[k]; var el;
      if (def.type === 'bool') el = h('input', { type: 'checkbox', id: 's-' + k, checked: !!v, disabled: !isOwner() });
      else if (def.type === 'enum') { el = h('select', { class: 'input', id: 's-' + k, disabled: !isOwner() }, [h('option', { value: '', text: 'Default (' + d.transport_default + ')' })].concat(def.values.map(function (x) { return h('option', { value: x, text: x }); }))); el.value = v || ''; }
      else el = h('input', { class: 'input', id: 's-' + k, type: 'number', min: String(def.min), max: String(def.max), value: String(v), disabled: !isOwner() });
      inputs[k] = el;
      return def.type === 'bool'
        ? h('div', { class: 'field' }, [h('label', { class: 'check', for: 's-' + k }, [el, h('b', { text: def.label })]), h('small', { text: def.help })])
        : h('div', { class: 'field' }, [h('label', { for: 's-' + k, text: def.label }), el, h('small', { text: def.help })]);
    });
    var save = function () {
      var out = {};
      Object.keys(defs).forEach(function (k) {
        var def = defs[k]; var el = inputs[k];
        var v = def.type === 'bool' ? el.checked : def.type === 'int' ? Number(el.value) : (el.value || null);
        if (v !== d.settings[k]) out[k] = v;
      });
      if (!Object.keys(out).length) { toast('Nothing changed'); return; }
      api('settings', { method: 'PATCH', body: out }).then(function () { toast('Saved'); load(); }).catch(fail);
    };
    var secrets = Object.keys(d.secrets).map(function (k) { return h('tr', {}, [h('td', { text: k }), h('td', {}, [pill(d.secrets[k] ? 'Set' : 'Not set', d.secrets[k] ? 'st-ok' : 'st-skipped')])]); })
      .concat(d.webhooks.map(function (w) { return h('tr', {}, [h('td', { text: w }), h('td', {}, [pill('Set', 'st-ok')])]); }));
    return h('div', {}, [head('Settings', isOwner() ? 'Kill switches and retention. Changes are logged.' : 'Only owners can change these.'),
      h('div', { class: 'card form' }, fields.concat(isOwner() ? [h('div', {}, [btn('Save settings', save, 'primary')])] : [])),
      spendPanel(d.spend),
      h('h2', { class: 'group', text: 'Secrets and connections' }),
      h('div', { class: 'tablewrap' }, [h('table', {}, [h('tbody', {}, secrets)])]),
      h('p', { class: 'small muted', text: 'Values are never shown. Set them with `npx wrangler secret put NAME` (README "Secrets").' }),
      h('p', {}, [h('a', { href: '#audit' }, ['Audit log: every change in ops, with who and when'])])]);
  }

  // ------------------------------------------------------------- drawer
  var lastFocus = null;
  function openDrawer(title, content) {
    closeDrawer(true);
    lastFocus = document.activeElement;
    var scrim = h('div', { class: 'scrim', onclick: function () { closeDrawer(); } });
    var x = h('button', { type: 'button', class: 'btn x', 'aria-label': 'Close', onclick: function () { closeDrawer(); } }, ['✕']);
    var drawer = h('div', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'drawer-title' }, [
      h('div', { class: 'dh' }, [h('h2', { id: 'drawer-title', text: title }), x]), h('div', { class: 'db' }, [content])]);
    drawer.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
      if (e.key === 'Tab') { // keep focus inside the drawer
        var f = drawer.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea');
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    S.drawer = [scrim, drawer];
    document.body.appendChild(scrim); document.body.appendChild(drawer);
    x.focus();
  }
  function closeDrawer(silent) {
    if (!S.drawer) return;
    S.drawer.forEach(function (e) { e.remove(); }); S.drawer = null;
    if (!silent) { history.replaceState(null, '', '#' + S.view); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  }

  // ------------------------------------------------------------- shared bits
  function table(headers, rows, cls) {
    return h('div', { class: 'tablewrap' }, [h('table', { class: cls || '' }, [h('thead', {}, [h('tr', {}, headers.map(function (t) { return h('th', { scope: 'col', text: t }); }))]), h('tbody', {}, rows)])]);
  }
  function card(title, link, kids, cls) {
    return h('section', { class: 'card ' + (cls || '') }, [h('h2', {}, [title, link ? h('a', { class: 'more', href: link[0] }, [link[1] || 'Open', h('span', { class: 'sr', text: ': ' + title })]) : null])].concat(kids));
  }
  function empty(text) { return h('div', { class: 'empty', text: text }); }
  function pct(n) { return n == null ? '—' : n + ' %'; }
  function prioPill(p) { return h('span', { class: 'pill pr-' + p, text: PRIO[p] || p }); }
  function issuePill(st) { return pill(ISSUE_ST[st] || st, st === 'resolved' ? 'st-ok' : st === 'wont_fix' ? 'st-skipped' : st === 'blocked' ? 'st-fail' : 'st-neutral'); }
  function field(id, label, el, help) { el.id = id; return h('div', { class: 'field' }, [h('label', { for: id, text: label }), el, help ? h('small', { text: help }) : null]); }
  function select(options, value) {
    var el = h('select', { class: 'input' }, options.map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
    el.value = value == null ? '' : value; return el;
  }
  function loadDirectory() {
    if (S.directory) return Promise.resolve(S.directory);
    return api('directory').then(function (d) { S.directory = d; return d; });
  }
  // One <datalist id="people-list"> for the whole page (assignee / owner pickers), filled from the directory once.
  function peopleList() {
    if (!document.getElementById('people-list')) {
      var dl = h('datalist', { id: 'people-list' });
      document.body.appendChild(dl);
      loadDirectory().then(function (d) { d.people.forEach(function (p) { dl.appendChild(h('option', { value: p.email, text: p.name || p.email })); }); }).catch(function () {});
    }
    return null;
  }
  function stateDot(st) { return { ok: 'green', up: 'green', fail: 'red', down: 'red', degraded: 'amber', unknown: 'grey' }[st] || 'grey'; }
  function stateLabel(st) { return { ok: 'Working', up: 'Working', fail: 'Problem', down: 'Down', degraded: 'Not quite right', unknown: 'Not checked yet' }[st] || st; }

  // ------------------------------------------------------------- Overview
  function viewOverview(d) {
    var failing = d.sites.filter(function (x) { return x.status === 'fail'; }).length;
    var parts = [head('Overview', 'Everything at a glance. Each card links to its page. Updates every minute.')];
    if (!d.cloudflare_token) parts.push(h('div', { class: 'banner', text: 'CF_API_TOKEN is not set: deploys, server errors, setup gaps and Access seats can\'t be read.' }));
    parts.push(h('div', { class: 'grid kpis' }, [
      kpi(failing, 'Sites with a problem', failing > 0), kpi(d.incidents.open == null ? '—' : d.incidents.open, 'Open incidents'),
      kpi(d.issues.total == null ? '—' : d.issues.total, 'Open issues', (d.issues.critical || 0) > 0), kpi(d.alerts.sent_24h == null ? '—' : d.alerts.sent_24h, 'Alerts sent (24 h)'),
    ]));
    var siteRows = d.sites.map(function (x) {
      return h('tr', {}, [h('td', {}, [h('span', { class: 'dot ' + stateDot(x.status), role: 'img', 'aria-label': stateLabel(x.status) }), ' ', h('a', { href: '#checks' }, [x.label])]),
        h('td', { text: x.last_deploy ? ago(x.last_deploy) : '—' }),
        h('td', {}, [x.deploy_result ? pill(x.deploy_result === 'regression' ? 'Worse after deploy' : x.deploy_result === 'failed' ? 'Failed' : x.deploy_result === 'watching' ? 'Watching' : 'OK',
          x.deploy_result === 'ok' || x.deploy_result === 'baseline' ? 'st-ok' : x.deploy_result === 'watching' ? 'st-neutral' : 'st-fail') : h('span', { class: 'muted', text: '—' })]),
        h('td', { class: 'num', text: pct(x.error_rate_24h) })]);
    });
    var sites = card('Sites', ['#checks', 'Sites & checks'], [table(['Site', 'Last deploy', 'Result', 'Errors 24 h'], siteRows)], 'wide');
    var inc = d.incidents.error ? [h('p', { class: 'muted', text: d.incidents.error })] : d.incidents.list.length ? [h('ul', { class: 'plain' }, d.incidents.list.slice(0, 5).map(function (i) {
      return h('li', {}, [sevPill(i.severity), ' ', i.title, h('span', { class: 'muted small', text: ' · ' + ago(i.opened_at) })]); }))] : [h('p', { class: 'ok-text', text: 'No open incidents.' })];
    var iss = d.issues.error ? [h('p', { text: d.issues.error })] : [h('div', { class: 'prio-row' }, ['critical', 'high', 'normal', 'low'].map(function (p) {
      return h('a', { class: 'prio-box pr-' + p, href: '#issues', onclick: function (e) { e.preventDefault(); S.issueFilter = { status: 'active', priority: p }; go('issues'); } }, [h('b', { text: String(d.issues[p] || 0) }), h('span', { text: PRIO[p] })]); }))];
    var af = d.autofix.error ? [h('p', { text: d.autofix.error })] : [
      h('p', {}, [pill(d.autofix.paused ? 'Paused (budget)' : d.autofix.enabled ? 'On' : 'Off', d.autofix.paused ? 'st-fail' : d.autofix.enabled ? 'st-ok' : 'st-skipped')]),
      h('dl', { class: 'mini' }, [h('dt', { text: 'Spent this month' }), h('dd', { text: money(d.autofix.spent) + ' of ' + money(d.autofix.budget) }), h('dt', { text: 'Forecast' }), h('dd', { text: money(d.autofix.forecast) })])];
    var bk = d.backups.error ? [h('p', { text: d.backups.error })] : [table(['Database', 'Last good backup', 'Last drill'], d.backups.databases.map(function (b) {
      var dr = (d.backups.drills || []).filter(function (x) { return x.db === b.db; })[0];
      return h('tr', {}, [h('td', { text: b.db }), h('td', {}, [b.last_status === 'failed' ? pill('Failed', 'st-fail') : null, ' ', b.last_ok ? ago(b.last_ok) : 'never']),
        h('td', {}, [dr ? pill(dr.status === 'ok' ? 'OK' : dr.status, dr.status === 'ok' ? 'st-ok' : 'st-fail') : h('span', { class: 'muted', text: 'none yet' })])]); }))];
    var gaps = [];
    if (d.setup.error) gaps.push(h('p', { text: d.setup.error }));
    else {
      d.setup.secrets.forEach(function (g) {
        gaps.push(h('li', {}, [h('b', { text: g.worker + ': ' }), g.unknown ? h('span', { class: 'muted', text: d.setup.errors && d.setup.errors[g.worker] ? 'can\'t check (' + d.setup.errors[g.worker] + ')' : 'can\'t check without CF_API_TOKEN' })
          : g.missing.length ? h('span', { class: 'warn-text', text: 'missing ' + g.missing.join(', ') }) : h('span', { class: 'ok-text', text: 'all secrets set' })]));
      });
      d.setup.other.forEach(function (o) { gaps.push(h('li', { class: 'warn-text', text: 'Missing: ' + o })); });
      gaps = [h('ul', { class: 'plain' }, gaps)];
    }
    var fb = !d.feedback || d.feedback.error ? [h('p', { class: 'muted', text: d.feedback ? d.feedback.error : 'Not connected.' })] : [
      h('p', {}, [h('b', { class: 'big', text: String(d.feedback.new_total) }), ' new this week', d.feedback.critical_open ? h('span', {}, [' · ', h('b', { class: 'warn-text', text: d.feedback.critical_open + ' critical open' })]) : ' · no critical open']),
      h('ul', { class: 'plain small' }, d.feedback.new_this_week.map(function (r) { return h('li', { text: (r.project || '?') + ': ' + r.n }); })),
      h('p', {}, [h('a', { href: 'https://feedback.overyondrdev.com/admin', target: '_blank', rel: 'noopener' }, ['Feedback admin'])])];
    var keys = d.keys.error ? [h('p', { text: d.keys.error })] : [d.keys.soon.length ? h('ul', { class: 'plain' }, d.keys.soon.map(function (k) {
      return h('li', {}, [pill(k.days_left < 0 ? 'expired' : k.days_left + ' days', k.days_left <= 14 ? 'st-fail' : 'st-neutral'), ' ', k.name, h('span', { class: 'muted small', text: ' · ' + k.location })]); }))
      : h('p', { class: 'ok-text', text: 'Nothing expires in the next 30 days.' }), d.keys.no_date ? h('p', { class: 'small muted', text: d.keys.no_date + ' of ' + d.keys.total + ' keys have no expiry date yet.' }) : null];
    var access = [h('dl', { class: 'mini' }, [h('dt', { text: 'Next access review' }), h('dd', { text: d.access.next_review || '—' }),
      h('dt', { text: 'Cloudflare Access seats' }), h('dd', {}, [d.access.seats ? pill(d.access.seats.status === 'ok' ? 'None in use' : d.access.seats.status === 'fail' ? d.access.seats.title : 'Not checked', d.access.seats.status === 'ok' ? 'st-ok' : d.access.seats.status === 'fail' ? 'st-fail' : 'st-skipped') : h('span', { class: 'muted', text: 'not checked yet' })])])];
    var ce = d.client_errors.error ? [h('p', { text: d.client_errors.error })] : d.client_errors.length ? [h('ul', { class: 'plain' }, d.client_errors.map(function (c) { return h('li', { text: c.project + ': ' + c.n + ' errors' }); }))] : [h('p', { class: 'ok-text', text: 'None reported in the last 24 hours.' })];
    var alerts = [h('p', {}, [h('b', { class: 'big', text: String(d.alerts.sent_24h || 0) }), ' sent in 24 hours', d.alerts.failed_24h ? h('span', { class: 'warn-text', text: ' · ' + d.alerts.failed_24h + ' failed' }) : null])];
    parts.push(h('div', { class: 'grid cards' }, [sites,
      card('Open incidents', ['#incidents', 'Incidents'], inc), card('Open issues', ['#issues', 'Issues'], iss), card('Auto-fix', ['#autofix', 'Auto-fixes'], af),
      card('Backups & drills', ['#backups', 'Backups'], bk, 'wide'), card('Setup gaps', ['#settings', 'Settings'], gaps), card('Feedback', null, fb),
      card('Keys expiring', ['#keys', 'Keys'], keys), card('Access', ['#people/review', 'Access review'], access), card('Browser errors', ['#errors', 'Errors'], ce),
      card('Alerts', ['#alerts', 'Alerts'], alerts)]));
    parts.push(h('p', { class: 'small muted', text: 'Generated ' + when(d.generated_at) + '. Cloudflare answers are cached for 5 minutes.' }));
    return h('div', {}, parts);
  }

  // ------------------------------------------------------------- Issues
  function viewIssues(d) {
    var f = S.issueFilter;
    var st = select([['active', 'Open, in progress, blocked'], ['', 'All']].concat(Object.keys(ISSUE_ST).map(function (k) { return [k, ISSUE_ST[k]]; })), f.status || '');
    var pr = select([['', 'Any priority']].concat(Object.keys(PRIO).map(function (k) { return [k, PRIO[k]]; })), f.priority || '');
    var src = select([['', 'Any source']].concat(Object.keys(SOURCES).map(function (k) { return [k, SOURCES[k]]; })), f.source || '');
    var who = h('input', { class: 'input', type: 'text', list: 'people-list', value: f.assignee || '', placeholder: 'anyone, none or an email', autocomplete: 'off' });
    var site = h('input', { class: 'input', type: 'text', value: f.site || '', placeholder: 'any' });
    var qq = h('input', { class: 'input', type: 'search', value: f.q || '', placeholder: 'words in title or text' });
    var form = h('form', { class: 'card filters', 'aria-label': 'Filter issues', onsubmit: function (e) {
      e.preventDefault();
      S.issueFilter = { status: st.value, priority: pr.value, source: src.value, assignee: who.value.trim(), site: site.value.trim(), q: qq.value.trim() };
      load();
    } }, [h('div', { class: 'inline' }, [field('f-status', 'Status', st), field('f-prio', 'Priority', pr), field('f-source', 'Source', src), field('f-who', 'Assignee', who), field('f-site', 'Site', site), field('f-q', 'Search', qq),
      h('button', { type: 'submit', class: 'btn' }, ['Filter'])]), peopleList()]);
    var rows = d.issues.map(function (i) {
      return h('button', { type: 'button', class: 'row click', onclick: function () { openIssue(i.id); } }, [
        h('span', { class: 'dot ' + (i.status === 'resolved' || i.status === 'wont_fix' ? 'grey' : i.priority === 'critical' || i.priority === 'high' ? 'red' : 'amber'), 'aria-hidden': 'true' }),
        h('div', {}, [h('div', { class: 't' }, ['#' + i.id + ' ' + i.title, ' ', prioPill(i.priority)]),
          h('div', { class: 'm' }, [h('span', { text: SOURCES[i.source] || i.source }), i.site ? h('span', { text: i.site }) : null, h('span', { text: i.assignee_email ? 'Assigned to ' + i.assignee_email : 'Not assigned' }),
            i.due_at ? h('span', { text: 'Due ' + i.due_at }) : null, h('span', { text: 'Updated ' + ago(i.updated_at) })])]),
        h('div', { class: 'act' }, [issuePill(i.status)])]);
    });
    return h('div', {}, [head('Issues', 'Everything that needs a person: opened by hand, from feedback, or automatically for incidents, failed deploys and auto-fixes.', [
      btn('From feedback item', fromFeedbackDialog), btn('New issue', newIssueDialog, 'primary')]),
      form, rows.length ? h('div', { class: 'list' }, rows) : empty('No issues match. Good news, probably.')]);
  }
  function newIssueDialog() {
    var title = h('input', { class: 'input', maxlength: '200', required: true });
    var desc = h('textarea', { class: 'input', maxlength: '8000' });
    var prio = select(Object.keys(PRIO).map(function (k) { return [k, PRIO[k]]; }), 'normal');
    var who = h('input', { class: 'input', type: 'email', list: 'people-list', autocomplete: 'off', placeholder: 'name@overyondr.com' });
    var due = h('input', { class: 'input', type: 'date' });
    var site = h('input', { class: 'input', maxlength: '100', placeholder: 'e.g. Website V1' });
    dialog('New issue', h('div', { class: 'form' }, [field('n-title', 'Title', title), field('n-desc', 'What\'s wrong / what to do', desc),
      h('div', { class: 'inline' }, [field('n-prio', 'Priority', prio), field('n-due', 'Due (optional)', due)]),
      field('n-who', 'Assign to (optional)', who, 'They get an email straight away.'), field('n-site', 'Site (optional)', site), peopleList()]), 'Create', function () {
      if (!title.value.trim()) { title.focus(); toast('Give it a title'); return false; }
      return api('issues', { method: 'POST', body: { title: title.value, description: desc.value, priority: prio.value, assignee_email: who.value || null, due_at: due.value || null, site: site.value || null } })
        .then(function (r) { toast('Issue #' + r.issue.id + ' created'); return load().then(function () { showIssue(r.issue); }); });
    });
  }
  function fromFeedbackDialog() {
    var n = h('input', { class: 'input', type: 'number', min: '1', step: '1', inputmode: 'numeric' });
    dialog('Create an issue from a feedback item', h('div', { class: 'form' }, [field('ff-id', 'Feedback item number', n, 'Copies only the item\'s title and text (personal details removed), its project and priority, and links to it.')]), 'Create', function () {
      if (!(Number(n.value) > 0)) { n.focus(); toast('Enter the item number'); return false; }
      return api('issues/from-feedback', { method: 'POST', body: { feedback_id: Number(n.value) } }).then(function (r) { toast('Issue #' + r.issue.id + ' created'); return load().then(function () { showIssue(r.issue); }); });
    });
  }
  function openIssue(id) { api('issues/' + id).then(function (r) { showIssue(r.issue); }).catch(fail); }
  function showIssue(i) {
    history.replaceState(null, '', '#issues/' + i.id);
    var st = select(Object.keys(ISSUE_ST).map(function (k) { return [k, ISSUE_ST[k]]; }), i.status);
    var pr = select(Object.keys(PRIO).map(function (k) { return [k, PRIO[k]]; }), i.priority);
    var who = h('input', { class: 'input', type: 'email', list: 'people-list', value: i.assignee_email || '', autocomplete: 'off', placeholder: 'Not assigned' });
    var due = h('input', { class: 'input', type: 'date', value: i.due_at || '' });
    var save = function () {
      return api('issues/' + i.id, { method: 'PATCH', body: { status: st.value, priority: pr.value, assignee_email: who.value.trim() || null, due_at: due.value || null } })
        .then(function (r) { toast('Saved'); load(); showIssue(r.issue); }).catch(fail);
    };
    var comment = h('textarea', { class: 'input', maxlength: '4000' });
    var addComment = function () {
      if (!comment.value.trim()) { comment.focus(); return; }
      api('issues/' + i.id + '/comments', { method: 'POST', body: { body: comment.value } }).then(function (r) { toast('Comment added'); showIssue(r.issue); }).catch(fail);
    };
    var ref = i.source_ref || '';
    var refLink = /^feedback:(\d+)/.test(ref) ? h('a', { href: 'https://feedback.overyondrdev.com/admin#item-' + ref.split(':')[1], target: '_blank', rel: 'noopener' }, ['Feedback #' + ref.split(':')[1]])
      : /^autofix:(\d+)/.test(ref) ? h('a', { href: '#autofix/' + ref.split(':')[1] }, ['Auto-fix #' + ref.split(':')[1]])
      : /^deploy:([^:]+)/.test(ref) ? h('a', { href: '#deploys/' + ref.split(':')[1] }, ['Deploys of ' + ref.split(':')[1]])
      : /^check:/.test(ref) ? h('a', { href: '#incidents' }, ['Incidents']) : (ref || '—');
    var content = h('div', { class: 'form' }, [
      h('div', { class: 'links' }, [issuePill(i.status), prioPill(i.priority), pill(SOURCES[i.source] || i.source)]),
      h('dl', { class: 'kv' }, [h('dt', { text: 'Linked to' }), h('dd', {}, [refLink]), h('dt', { text: 'Site' }), h('dd', { text: i.site || '—' }),
        h('dt', { text: 'Created' }), h('dd', { text: when(i.created_at) + ' by ' + i.created_by }), i.resolved_at ? h('dt', { text: 'Resolved' }) : null, i.resolved_at ? h('dd', { text: when(i.resolved_at) }) : null]),
      i.description ? h('div', { class: 'card desc', text: i.description }) : null,
      h('div', { class: 'inline' }, [field('i-st', 'Status', st), field('i-pr', 'Priority', pr), field('i-due', 'Due', due)]),
      field('i-who', 'Assignee', who, 'Anyone in People & permissions. They get an email.'), peopleList(),
      h('div', {}, [btn('Save changes', save, 'primary')]),
      h('h3', { class: 'group', text: 'Timeline' }),
      h('ol', { class: 'timeline' }, i.events.map(function (e) { return h('li', {}, [h('div', {}, [h('div', { class: e.kind === 'comment' ? 'comment' : '', text: e.message }), h('div', { class: 'who', text: when(e.created_at) + ' · ' + e.actor + ' · ' + e.kind })])]); })),
      field('i-comment', 'Add a comment', comment), h('div', {}, [btn('Comment', addComment)]),
    ]);
    openDrawer('#' + i.id + ' ' + i.title, content);
  }

  // ------------------------------------------------------------- Status (all staff)
  function viewStatus(d) {
    var down = d.sites.filter(function (x) { return x.state === 'down' || x.state === 'degraded'; });
    var pause = btn(S.paused ? 'Resume auto-refresh' : 'Pause auto-refresh', function () { S.paused = !S.paused; pause.textContent = S.paused ? 'Resume auto-refresh' : 'Pause auto-refresh'; });
    var rows = d.sites.map(function (x) {
      return h('tr', {}, [h('th', { scope: 'row' }, [h('span', { class: 'dot ' + stateDot(x.state), 'aria-hidden': 'true' }), ' ', x.site]),
        h('td', { text: stateLabel(x.state) }), h('td', { class: 'num', text: pct(x.uptime_7d) }), h('td', { class: 'num', text: pct(x.uptime_30d) })]);
    });
    var inc = d.incidents.map(function (i) { return h('li', { class: i.open ? 'open' : '' }, [h('b', { text: i.text }), h('span', { class: 'muted small', text: ' ' + (i.open ? 'Since ' + when(i.opened_at) : 'Fixed ' + when(i.resolved_at)) })]); });
    return h('div', { class: 'status-page' }, [head('Status', 'Is everything working? Checked every 5 minutes; this page refreshes every minute.', [pause]),
      h('div', { class: 'banner ' + (down.length ? 'red' : 'green'), role: 'status' }, [down.length ? down.length + ' site' + (down.length > 1 ? 's have' : ' has') + ' a problem. The team has been alerted.' : 'All sites are working.']),
      table(['Site', 'Now', 'Uptime 7 days', 'Uptime 30 days'], rows, 'status-table'),
      h('h2', { class: 'group', text: 'Incidents (last 7 days)' }),
      inc.length ? h('ul', { class: 'plain incidents' }, inc) : h('p', { class: 'muted', text: 'None.' }),
      h('p', { class: 'small muted', text: 'Last checked ' + (d.updated_at ? when(d.updated_at) + ' (' + ago(d.updated_at) + ')' : 'never') + '.' })]);
  }

  // ------------------------------------------------------------- Errors
  function sparkline(hourly, label) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 96 24'); svg.setAttribute('class', 'spark'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label);
    var max = Math.max.apply(null, [1].concat(hourly.map(function (x) { return x.errors; })));
    hourly.slice(-24).forEach(function (x, i) {
      var r = document.createElementNS(NS, 'rect'); var hgt = Math.max(1, Math.round((x.errors / max) * 22));
      r.setAttribute('x', String(i * 4)); r.setAttribute('y', String(24 - hgt)); r.setAttribute('width', '3'); r.setAttribute('height', String(hgt));
      r.setAttribute('class', x.errors ? 'bar-err' : 'bar-ok'); svg.appendChild(r);
    });
    return svg;
  }
  function viewErrors(d) {
    var t = d.thresholds;
    var rows = d.workers.map(function (w) {
      var bad = w.requests_1h >= t.minRequests && w.rate_1h > t.warnPct;
      return h('tr', {}, [h('th', { scope: 'row' }, [w.label, h('div', { class: 'small muted', text: w.worker })]), h('td', { class: 'num', text: String(w.requests_1h) }), h('td', { class: 'num', text: String(w.errors_1h) }),
        h('td', { class: 'num' }, [bad ? pill(w.rate_1h + ' %', 'st-fail') : pct(w.rate_1h)]), h('td', { class: 'num', text: pct(w.rate_24h) + ' (' + w.errors_24h + ')' }),
        h('td', {}, [w.hourly.length ? sparkline(w.hourly, 'Errors per hour, last 24 hours: ' + w.hourly.map(function (x) { return x.errors; }).join(', ')) : h('span', { class: 'muted small', text: 'no data' })])]);
    });
    var client = d.client.map(function (c) { return h('tr', {}, [h('td', { text: c.project }), h('td', { class: 'num', text: String(c.count_24h) }), h('td', { text: ago(c.last) })]); });
    var samples = [];
    d.client_recent.forEach(function (r) { r.sample.forEach(function (x) { samples.push(h('tr', {}, [h('td', { text: when(r.received_at) }), h('td', { text: r.project }), h('td', { class: 'code-text', text: x.message }), h('td', { class: 'code-text', text: x.source }), h('td', { text: x.page_path })])); }); });
    return h('div', {}, [head('Errors', 'Server errors per Worker (Cloudflare analytics) and JavaScript errors in visitors\' browsers (reported by the feedback widget).'),
      h('h2', { class: 'group', text: 'Server errors' }),
      h('p', { class: 'small muted', text: 'Alert when more than ' + t.warnPct + ' % of requests fail in ' + t.windowMinutes + ' minutes (high above ' + t.highPct + ' %), with at least ' + t.minRequests + ' requests. "Errors" are uncaught exceptions and exceeded limits.' }),
      table(['Worker', 'Requests 1 h', 'Errors 1 h', 'Rate 1 h', 'Rate 24 h', 'Errors per hour'], rows),
      h('h2', { class: 'group', text: 'Browser errors (24 hours)' }),
      client.length ? table(['Project', 'Errors', 'Last report'], client) : empty('No browser errors reported. (The feedback widget reports them; nothing reported can also mean it isn\'t sending yet.)'),
      samples.length ? h('div', {}, [h('h3', { class: 'group', text: 'Recent examples' }), table(['When', 'Project', 'Message', 'Where', 'Page'], samples.slice(0, 40))]) : null]);
  }

  // ------------------------------------------------------------- Deploys
  function viewDeploys(d) {
    var parts = [head('Deploys', 'Recent deployments per Worker. Each new one is watched for 15 minutes; if errors go up or a site check starts failing, people are alerted.', [
      btn('Refresh from Cloudflare', function (e) { e.target.disabled = true; api('deploys?refresh=1').then(function (r) { shell(viewDeploys(r)); }).catch(fail); })])];
    if (!d.rollback_ready) parts.push(h('div', { class: 'banner', text: 'One-click rollback needs the CF_DEPLOY_TOKEN secret (a Cloudflare API token with Workers Scripts: Edit; README "Secrets"). Until then, roll back in the Cloudflare dashboard.' }));
    d.workers.forEach(function (w) {
      var rows = w.deployments.map(function (dep) {
        var v = dep.versions.map(function (x) { return x.version_id.slice(0, 8) + (x.percentage !== 100 ? ' (' + x.percentage + ' %)' : ''); }).join(', ');
        return h('tr', {}, [h('td', { text: when(dep.created_on) }), h('td', { text: dep.source || '—' }), h('td', { text: dep.author || dep.triggered_by || '—' }), h('td', { class: 'code-text', text: v }), h('td', { text: dep.message || '' })]);
      });
      var watches = w.watches.filter(function (x) { return x.status !== 'baseline'; }).slice(0, 3).map(function (x) {
        return h('li', {}, [pill(x.status === 'ok' ? 'Fine after deploy' : x.status === 'watching' ? 'Watching' : 'Worse after deploy', x.status === 'ok' ? 'st-ok' : x.status === 'watching' ? 'st-neutral' : 'st-fail'), ' ', when(x.deployed_at), x.detail ? h('span', { class: 'small muted', text: ' · ' + x.detail }) : null]);
      });
      var canRoll = isOwner() && d.rollback_ready && w.previous_version;
      parts.push(h('section', { class: 'card deploy', id: 'deploy-' + w.worker, tabindex: '-1', 'aria-labelledby': 'dh-' + w.worker }, [
        h('h2', { id: 'dh-' + w.worker }, [w.label, h('small', { text: w.worker })]),
        w.error ? h('p', { class: 'warn-text small', text: w.error }) : null,
        watches.length ? h('ul', { class: 'plain' }, watches) : null,
        rows.length ? table(['When', 'Source', 'Who', 'Version', 'Message'], rows) : h('p', { class: 'muted', text: w.error ? '' : 'No deployments found.' }),
        h('p', { class: 'inline' }, [w.current_version ? h('span', { class: 'small muted', text: 'Live: ' + w.current_version.slice(0, 8) + (w.previous_version ? ' · previous: ' + w.previous_version.slice(0, 8) : '') }) : null,
          canRoll ? btn('Roll back', function () { rollbackDialog(w); }, 'danger') : h('span', { class: 'small muted', text: !isOwner() ? 'Only owners can roll back.' : !d.rollback_ready ? 'Rollback needs CF_DEPLOY_TOKEN.' : !w.previous_version ? 'No earlier version to roll back to.' : '' })]),
      ]));
    });
    return h('div', {}, parts);
  }
  function rollbackDialog(w) {
    dialog('Roll back ' + w.label + '?', h('div', {}, [
      h('p', { text: 'The previous version (' + w.previous_version.slice(0, 8) + ') will serve 100 % of traffic for ' + w.worker + ', replacing ' + w.current_version.slice(0, 8) + '. Owners are told, and it is in the audit log.' }),
      h('ul', {}, [h('li', { text: 'The next normal deploy from main replaces the rollback: fix main (or revert the change) before merging anything else.' }),
        h('li', { text: 'Database changes (D1 migrations) are NOT rolled back. If the bad version changed the database, the old code must still work with it.' })]),
    ]), 'Roll back now', function () {
      return api('deploys/' + w.worker + '/rollback', { method: 'POST', body: { version_id: w.previous_version } }).then(function () { toast(w.label + ' rolled back'); load(); });
    }, true);
  }

  // ------------------------------------------------------------- Backups: restore drills
  function drillsSection(d) {
    var rows = d.drills.map(function (x) {
      return h('tr', {}, [h('td', { text: when(x.started_at) }), h('td', {}, [x.db, x.pii ? h('span', { class: 'locked', text: 'Personal data' }) : null]),
        h('td', {}, [pill(x.status === 'ok' ? 'OK' : x.status, x.status === 'ok' ? 'st-ok' : x.status === 'running' ? 'st-neutral' : 'st-fail')]),
        h('td', { text: x.backup_day || '—' }), h('td', { class: 'num', text: x.tables_restored == null ? '—' : x.tables_restored + ' / ' + x.tables_expected }),
        h('td', { class: 'num', text: x.rows_restored == null ? '—' : x.rows_restored + ' / ' + x.rows_expected }), h('td', { class: 'small', text: x.detail || '' }),
        h('td', { class: 'small', text: x.triggered_by })]);
    });
    return h('section', { 'aria-labelledby': 'drills-title' }, [
      h('h2', { class: 'group', id: 'drills-title', text: 'Restore drills' }),
      h('p', { class: 'small muted', text: 'On the 1st of each month the latest backup of every database is restored into the scratch database yondr-ops-restore-drill and its tables and rows are compared with the backup. Christmas-card data is deleted from the scratch database straight after.' }),
      isOwner() ? h('p', {}, [btn('Run restore drill now', function (e) { e.target.disabled = true; api('drills/run', { method: 'POST' }).then(function () { toast('Restore drill started. Refresh in a minute.'); }).catch(function (er) { e.target.disabled = false; fail(er); }); })]) : null,
      !d.ready ? h('div', { class: 'banner', text: 'The DRILL_DB binding is missing, so drills can\'t run.' }) : null,
      rows.length ? table(['When', 'Database', 'Result', 'Backup of', 'Tables', 'Rows', 'Detail', 'By'], rows) : empty('No restore drill has run yet.')]);
  }

  // ------------------------------------------------------------- People & permissions
  function roleText(r) { return r || '—'; }
  function viewPeople(d) {
    S.directory = d;
    var fbAdmins = d.people.filter(function (p) { return p.roles.feedback; });
    var email = h('input', { class: 'input', type: 'email', autocomplete: 'off', placeholder: 'name@overyondr.com' });
    var role = select([['admin', 'Admin']].concat(isOwner() ? [['owner', 'Owner']] : []), 'admin');
    var addForm = h('form', { class: 'card', onsubmit: function (e) {
      e.preventDefault();
      api('permissions/feedback-admins', { method: 'POST', body: { email: email.value, role: role.value } }).then(function () { toast('Saved in the feedback tool'); S.directory = null; load(); }).catch(fail);
    } }, [h('h2', { text: 'Give someone admin access' }), h('div', { class: 'inline' }, [field('pa-email', 'Work email', email), field('pa-role', 'Role', role), h('button', { type: 'submit', class: 'btn primary' }, ['Save'])]),
      h('p', { class: 'small muted', text: 'Admins can use Ops and the feedback admin; owners can also change Settings, approve spend, roll back and manage owners. Changes are made by the feedback tool with your own sign-in, so its rules apply (only owners change owners; nobody removes themselves). Logged in the audit log.' })]);
    var adminRows = fbAdmins.map(function (p) {
      var isOwnerRow = p.roles.feedback === 'owner';
      return h('tr', {}, [h('th', { scope: 'row' }, [p.name || p.email, p.name ? h('div', { class: 'small muted', text: p.email }) : null]),
        h('td', {}, [pill(isOwnerRow ? 'Owner' : 'Admin', isOwnerRow ? 'st-ok' : 'st-neutral')]), h('td', { text: p.last_seen_any ? ago(p.last_seen_any) : 'never' }),
        h('td', {}, [h('div', { class: 'act' }, [
          isOwner() && p.email !== S.me.email ? btn(isOwnerRow ? 'Make admin' : 'Make owner', function () { changeRole(p.email, isOwnerRow ? 'admin' : 'owner'); }) : null,
          p.email !== S.me.email ? btn('Remove', function () { removeAdmin(p.email); }, 'danger') : null])])]);
    });
    var tools = d.tools;
    var all = d.people.map(function (p) {
      return h('tr', {}, [h('th', { scope: 'row' }, [h('button', { type: 'button', class: 'linkish', onclick: function () { openPerson2(p); } }, [p.name || p.email]), p.name ? h('div', { class: 'small muted', text: p.email }) : null]),
        h('td', { text: roleText(p.roles.feedback) }), h('td', { text: roleText(p.roles.ads) }), h('td', { text: roleText(p.roles.requests) }),
        h('td', { text: p.alerts ? 'yes' : '—' }), h('td', { text: p.last_seen_any ? ago(p.last_seen_any) : 'never' })]);
    });
    var review = d.review.map(function (p) {
      return h('tr', {}, [h('th', { scope: 'row', text: p.name || p.email }), h('td', { text: Object.keys(p.roles).map(function (k) { return (tools[k] ? tools[k].label : k) + ': ' + p.roles[k]; }).join('; ') }),
        h('td', { text: p.last_seen ? when(p.last_seen) : 'never' }), h('td', {}, [p.stale ? pill('Not seen for ' + d.stale_days + '+ days', 'st-fail') : pill('Active', 'st-ok')])]);
    });
    var srcNote = [!d.sources.ads ? 'ad library' : null, !d.sources.requests ? 'marketing requests' : null].filter(Boolean);
    return h('div', {}, [head('People & permissions', 'Everyone with access to Yondr tools. Feedback and Ops roles can be changed here; other tools link to where they are managed.'),
      addForm,
      h('h2', { class: 'group', text: 'Feedback tool & Ops: owners and admins' }),
      adminRows.length ? table(['Person', 'Role', 'Last seen', ''], adminRows) : empty('No admins found.'),
      h('h2', { class: 'group', id: 'everyone', text: 'Everyone' }),
      srcNote.length ? h('p', { class: 'small muted', text: 'Could not read people from: ' + srcNote.join(', ') + '.' }) : null,
      table(['Person', 'Feedback & Ops', 'Ad library', 'Marketing requests', 'Alerts', 'Last seen'], all),
      h('p', { class: 'small muted' }, ['Manage elsewhere: ', h('a', { href: tools.ads.manage, target: '_blank', rel: 'noopener' }, ['Ad library']), ' · ', h('a', { href: tools.requests.manage, target: '_blank', rel: 'noopener' }, ['Marketing requests']), ' · ', h('a', { href: tools.cards.manage, target: '_blank', rel: 'noopener' }, ['Christmas cards'])]),
      h('section', { 'aria-labelledby': 'review-title', id: 'review', tabindex: '-1' }, [
        h('h2', { class: 'group', id: 'review-title', text: 'Access review' }),
        h('p', { class: 'small muted', text: 'Everyone with an admin-type role in any tool. People not seen for ' + d.stale_days + ' days are flagged. An issue with this list opens on the first weekday of every quarter; next: ' + (d.next_review || '—') + '.' }),
        isOwner() ? h('p', {}, [btn('Open a review issue now', function (e) { e.target.disabled = true; api('access-review/open', { method: 'POST' }).then(function (r) { toast('Issue #' + r.issue_id + ' opened'); }).catch(fail); })]) : null,
        review.length ? table(['Person', 'Roles', 'Last seen', ''], review) : empty('Nobody has an admin-type role.')])]);
  }
  function changeRole(email, role) {
    dialog((role === 'owner' ? 'Make ' : 'Make ') + email + ' ' + role + '?', h('p', { text: role === 'owner' ? 'Owners can change Settings, approve spend, roll back deploys and manage other owners.' : 'They keep admin access but lose owner rights.' }), 'Save', function () {
      return api('permissions/feedback-admins', { method: 'POST', body: { email: email, role: role } }).then(function () { toast('Saved'); S.directory = null; load(); });
    });
  }
  function removeAdmin(email) {
    dialog('Remove ' + email + ' as admin?', h('p', { text: 'They can no longer use Ops or the feedback admin. Their alerts (if any) continue until removed in Alerts.' }), 'Remove', function () {
      return api('permissions/feedback-admins', { method: 'DELETE', body: { email: email } }).then(function () { toast('Removed'); S.directory = null; load(); });
    }, true);
  }
  function openPerson2(p) {
    var tools = S.directory.tools;
    var rows = Object.keys(tools).map(function (k) {
      var has = p.roles[k];
      return h('li', { class: 'check-item' }, [h('b', { text: tools[k].label + ': ' }), has ? has : h('span', { class: 'muted', text: k === 'cards' ? 'not shown here' : 'no role' }),
        p.last_seen[k] ? h('span', { class: 'small muted', text: ' · last seen ' + when(p.last_seen[k]) }) : null, ' ',
        k === 'feedback' && has ? (p.email !== S.me.email ? btn('Remove here', function () { closeDrawer(); removeAdmin(p.email); }, 'danger') : null)
          : h('a', { href: tools[k].manage, target: '_blank', rel: 'noopener' }, ['Manage in ' + tools[k].label])]);
    });
    openDrawer(p.name || p.email, h('div', { class: 'form' }, [
      h('dl', { class: 'kv' }, [h('dt', { text: 'Email' }), h('dd', { text: p.email }), h('dt', { text: 'Last seen in Ops' }), h('dd', { text: p.last_seen.ops ? when(p.last_seen.ops) : 'never' }),
        h('dt', { text: 'Gets alerts' }), h('dd', { text: p.alerts ? 'yes (Alerts page)' : 'no' }), h('dt', { text: 'Has issues assigned' }), h('dd', { text: p.assignee ? 'yes' : 'no' })]),
      h('h3', { class: 'group', text: 'Remove from all tools (checklist)' }),
      h('ul', { class: 'plain checklist' }, rows),
      h('p', { class: 'small muted', text: 'Only Feedback & Ops roles can be changed from here. Also remove them from alerts (Alerts) and reassign their open issues.' })]));
  }

  // ------------------------------------------------------------- Keys
  function viewKeys(d) {
    var rows = d.keys.map(function (k) {
      var dl = k.days_left;
      return h('tr', {}, [h('th', { scope: 'row', text: k.name }), h('td', { text: k.location }), h('td', { text: k.owner_email || '—' }),
        h('td', {}, [k.expires_on ? k.expires_on + ' ' : h('span', { class: 'muted', text: 'not set ' }), dl == null ? null : pill(dl < 0 ? 'expired' : dl === 0 ? 'today' : dl + ' days', dl <= 14 ? 'st-fail' : dl <= 30 ? 'st-neutral' : 'st-ok')]),
        h('td', { text: k.last_rotated || '—' }), h('td', { class: 'small', text: k.rotation_notes || '' }), h('td', {}, [btn('Edit', function () { keyDialog(k); })])]);
    });
    return h('div', {}, [head('Keys', 'When each key and token expires, where it lives and who rotates it. Never the keys themselves.', [btn('Add a key', function () { keyDialog(null); }, 'primary')]),
      h('p', { class: 'small muted', text: 'Owners (and the key\'s owner) are emailed 30 and 14 days before a key expires, and on the day.' }),
      table(['Key', 'Where it lives', 'Owner', 'Expires', 'Last rotated', 'How to rotate', ''], rows)]);
  }
  function keyDialog(k) {
    var name = h('input', { class: 'input', maxlength: '80', value: k ? k.name : '' });
    var loc = h('input', { class: 'input', maxlength: '200', value: k ? k.location : '', placeholder: 'e.g. yondr-ops Worker secret' });
    var owner = h('input', { class: 'input', type: 'email', list: 'people-list', value: k && k.owner_email ? k.owner_email : '', autocomplete: 'off' });
    var exp = h('input', { class: 'input', type: 'date', value: k && k.expires_on ? k.expires_on : '' });
    var rot = h('input', { class: 'input', type: 'date', value: k && k.last_rotated ? k.last_rotated : '' });
    var notes = h('textarea', { class: 'input', maxlength: '1000' }); notes.value = k && k.rotation_notes ? k.rotation_notes : '';
    var body = h('div', { class: 'form' }, [h('p', { class: 'banner', text: 'Never paste a key here. Only its name, where it lives and when it expires.' }),
      field('k-name', 'Name', name), field('k-loc', 'Where it lives', loc), h('div', { class: 'inline' }, [field('k-exp', 'Expires on', exp), field('k-rot', 'Last rotated', rot)]),
      field('k-owner', 'Owner (gets the reminders too)', owner), field('k-notes', 'How to rotate', notes), peopleList(),
      k && isOwner() ? h('p', {}, [btn('Remove from the calendar', function () { api('keys/' + k.id, { method: 'DELETE' }).then(function () { toast('Removed'); document.querySelector('dialog').close(); load(); }).catch(fail); }, 'danger')]) : null]);
    dialog(k ? 'Edit ' + k.name : 'Add a key', body, 'Save', function () {
      var payload = { name: name.value, location: loc.value, owner_email: owner.value || null, expires_on: exp.value || null, last_rotated: rot.value || null, rotation_notes: notes.value || null };
      return api(k ? 'keys/' + k.id : 'keys', { method: k ? 'PATCH' : 'POST', body: payload }).then(function () { toast('Saved'); load(); });
    });
  }

  // ------------------------------------------------------------- Audit log
  function viewAudit(d) {
    var actor = h('input', { class: 'input', type: 'email', list: 'people-list', value: S.auditActor || '', autocomplete: 'off' });
    var action = select([['', 'Everything'], ['permission', 'Permissions'], ['issue', 'Issues'], ['deploy', 'Rollbacks'], ['key', 'Keys'], ['settings', 'Settings'], ['autofix', 'Auto-fix'], ['backup', 'Backups'], ['drill', 'Restore drills'], ['person', 'Alert people'], ['check', 'Mutes']], S.auditAction || '');
    var form = h('form', { class: 'card filters', 'aria-label': 'Filter the audit log', onsubmit: function (e) { e.preventDefault(); S.auditActor = actor.value.trim(); S.auditAction = action.value; load(); } },
      [h('div', { class: 'inline' }, [field('a-actor', 'Who', actor), field('a-action', 'What', action), h('button', { type: 'submit', class: 'btn' }, ['Filter'])]), peopleList()]);
    var rows = d.audit.map(function (a) { return h('tr', {}, [h('td', { text: when(a.created_at) }), h('td', { text: a.actor }), h('td', { text: a.action }), h('td', { class: 'small code-text', text: a.detail === '{}' ? '' : a.detail })]); });
    return h('div', {}, [head('Audit log', 'Every change made in Ops: settings, permissions, rollbacks, keys, issues, mutes, downloads. Auto-fix steps have their own timeline.'), form,
      rows.length ? table(['When', 'Who', 'What', 'Details'], rows) : empty('Nothing logged yet.')]);
  }

  // ------------------------------------------------------------- loading
  function qs(o) { var k = Object.keys(o).filter(function (x) { return o[x]; }); return k.length ? '?' + k.map(function (x) { return x + '=' + encodeURIComponent(o[x]); }).join('&') : ''; }
  var LOADERS = {
    overview: function () { return api('overview').then(viewOverview); },
    issues: function () { return api('issues' + qs(S.issueFilter)).then(viewIssues); },
    status: function () { return api('status/public').then(viewStatus); },
    checks: function () { return api('status').then(viewChecks); },
    incidents: function () { return api('incidents').then(viewIncidents); },
    errors: function () { return api('errors').then(viewErrors); },
    deploys: function () { return api('deploys').then(viewDeploys); },
    alerts: function () { return Promise.all([api('people'), api('alerts')]).then(function (r) { S.data.people = r[0]; return viewAlerts({ people: r[0], log: r[1] }); }); },
    backups: function () { return Promise.all([api('backups'), api('drills')]).then(function (r) { var el = viewBackups(r[0]); el.appendChild(drillsSection(r[1])); return el; }); },
    autofix: function () { return Promise.all([api('autofix' + (S.afAll ? '' : '?status=active')), api('autofix/config'), api('autofix/spend')]).then(function (r) { return viewAutofix({ autofixes: r[0].autofixes, config: r[1], spend: r[2] }); }); },
    people: function () { return api('directory').then(viewPeople); },
    keys: function () { return api('keys').then(viewKeys); },
    settings: function () { return Promise.all([api('settings'), api('autofix/spend')]).then(function (r) { r[0].spend = r[1]; return viewSettings(r[0]); }); },
    audit: function () { return api('audit' + qs({ actor: S.auditActor, action: S.auditAction })).then(viewAudit); },
  };
  // S.view comes from the URL hash: match it against fixed names, never use it as an object key (CodeQL).
  function loaderFor(view) {
    switch (view) {
      case 'issues': return LOADERS.issues;
      case 'status': return LOADERS.status;
      case 'checks': return LOADERS.checks;
      case 'incidents': return LOADERS.incidents;
      case 'errors': return LOADERS.errors;
      case 'deploys': return LOADERS.deploys;
      case 'alerts': return LOADERS.alerts;
      case 'backups': return LOADERS.backups;
      case 'autofix': return LOADERS.autofix;
      case 'people': return LOADERS.people;
      case 'keys': return LOADERS.keys;
      case 'settings': return LOADERS.settings;
      case 'audit': return LOADERS.audit;
      default: return LOADERS.overview;
    }
  }
  function load() {
    var view = S.view;
    return loaderFor(view)().then(function (el) { if (S.view === view) shell(el); })
      .catch(function (er) { shell(h('div', {}, [head('Something went wrong'), h('div', { class: 'banner red', role: 'alert', text: er.message }), btn('Try again', load)])); });
  }
  function focusTarget(id) { var el = document.getElementById(id); if (el) { el.setAttribute('tabindex', '-1'); el.scrollIntoView(); el.focus(); } }
  function deepLink(parts) {
    if (parts[0] === 'autofix') {
      if (parts[1] === 'spend') focusTarget('spend'); // link in budget alerts
      else if (parts[1] === 'feedback' && parts[2]) openAutofixByFeedback(Number(parts[2])); // link from the feedback admin
      else if (parts[1]) openAutofix(Number(parts[1]));
    }
    if (parts[0] === 'issues' && parts[1]) openIssue(Number(parts[1]));
    if (parts[0] === 'deploys' && parts[1]) focusTarget('deploy-' + parts[1]);
    if (parts[0] === 'people' && parts[1] === 'review') focusTarget('review');
  }
  function denied() {
    app.replaceChildren(h('div', { class: 'denied' }, [h('div', {}, [h('img', { src: '/brand/yondr-lichen.svg', alt: 'Yondr', width: '110' }),
      h('h1', { text: 'Admins only' }), h('p', { text: 'You are signed in as ' + S.me.email + ', who is not an admin. Ops uses the same admin list as the feedback tool: ask an owner to add you there (People).' }),
      h('p', {}, [h('a', { href: 'https://auth.overyondrdev.com/logout?return=' + encodeURIComponent(location.origin + '/') }, ['Sign in as someone else'])])])]));
  }

  function route() {
    var parts = location.hash.replace('#', '').split('/');
    if (location.pathname === '/status' && !parts[0]) parts = ['status'];
    return parts;
  }
  function start() {
    var parts = route();
    api('me').then(function (me) {
      S.me = me;
      if (!me.role) {
        // Staff who aren't admins: the status page only.
        if (!me.staff) return denied();
        S.view = 'status';
        if (location.pathname !== '/status') history.replaceState(null, '', '/status');
      } else if (Object.prototype.hasOwnProperty.call(LOADERS, parts[0])) S.view = parts[0];
      loading();
      return load().then(function () { deepLink(parts); });
    }).catch(function (er) { app.replaceChildren(h('div', { class: 'denied' }, [h('div', {}, [h('h1', { text: 'Can\'t load' }), h('p', { text: er.message })])])); });
  }
  window.addEventListener('hashchange', function () {
    if (isStaff()) return;
    var parts = route();
    if (Object.prototype.hasOwnProperty.call(LOADERS, parts[0]) && parts[0] !== S.view) { S.view = parts[0]; load().then(function () { deepLink(parts); }); }
    else deepLink(parts);
  });
  // Live views refresh every minute (not while a drawer or dialog is open, the tab is hidden, or refresh is paused).
  setInterval(function () {
    if (['status', 'overview', 'checks'].indexOf(S.view) >= 0 && !S.paused && !S.drawer && !document.querySelector('dialog') && document.visibilityState === 'visible' && !(document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName))) load();
  }, 60000);
  start();
})();
