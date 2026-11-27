/* Yondr Ops dashboard (ops.overyondrdev.com). Plain JS, no dependencies. */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var VIEWS = [['status', 'Status'], ['incidents', 'Incidents'], ['alerts', 'Alerts'], ['backups', 'Backups'], ['autofix', 'Auto-fixes'], ['settings', 'Settings']];
  var SEV = { info: 'Info', warning: 'Warning', high: 'High', critical: 'Critical' };
  var AF_STATUS = { queued: 'Queued', triaged: 'Triaged', fixing: 'Fixing', pr_open: 'PR open', checks_failed: 'Checks failed', merged: 'Merged',
    deployed: 'Deployed', verified: 'Verified', failed: 'Failed', reverted: 'Reverted', rejected: 'Rejected' };
  var S = { me: null, view: 'status', data: {}, drawer: null, afAll: false };

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
  function go(view) { S.view = view; history.replaceState(null, '', '#' + view); load(); }
  function shell(content) {
    var nav = h('nav', { class: 'nav', 'aria-label': 'Sections' }, VIEWS.map(function (v) {
      return h('button', { type: 'button', 'aria-current': S.view === v[0] ? 'page' : false, onclick: function () { go(v[0]); } }, [h('span', { text: v[1] })]);
    }));
    var side = h('aside', { class: 'side' }, [
      h('a', { class: 'brand', href: '#status' }, [h('img', { src: '/brand/yondr-lichen.svg', alt: 'Yondr' }), h('span', { text: 'Ops' })]),
      nav, h('div', { class: 'spacer' }),
      h('div', { class: 'me' }, [h('b', { text: S.me.email }), h('span', { text: S.me.role === 'owner' ? 'Owner' : 'Admin' }),
        h('a', { href: 'https://auth.overyondrdev.com/logout?return=' + encodeURIComponent(location.origin + '/') }, ['Sign out'])]),
    ]);
    var main = h('main', { class: 'main', id: 'main', tabindex: '-1' }, [content]);
    app.replaceChildren(h('div', { class: 'app' }, [side, main]));
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
  function viewStatus(d) {
    var checks = d.checks;
    var failing = checks.filter(function (c) { return c.state && c.state.status === 'fail'; });
    var ok = checks.filter(function (c) { return c.state && c.state.status === 'ok'; });
    var parts = [head('Status', 'Every site and setting ops watches. Checks run every 5 minutes.', [
      btn('Run checks now', function (e) { e.target.disabled = true; api('checks/run', { method: 'POST' }).then(function () { toast('Checks finished'); load(); }).catch(function (er) { e.target.disabled = false; fail(er); }); }, 'primary'),
    ])];
    var off = Object.keys(d.switches).filter(function (k) { return k !== 'autofix_enabled' && !d.switches[k]; });
    if (off.length) parts.push(h('div', { class: 'banner red', role: 'alert', text: 'Switched off: ' + off.map(function (k) { return k.replace('_enabled', ''); }).join(', ') + '. See Settings.' }));
    if (!d.cloudflare_token) parts.push(h('div', { class: 'banner', text: 'The Cloudflare API token (CF_API_TOKEN) is not set, so deploy, Access, inventory and usage checks are skipped.' }));
    parts.push(h('div', { class: 'grid kpis' }, [
      kpi(failing.length, 'Problems now', failing.length > 0), kpi(ok.length + ' / ' + checks.length, 'Checks passing'),
      kpi(d.open_incidents, 'Open incidents'), kpi(d.last_monitor ? ago(d.last_monitor.started_at) : 'never', 'Last check'),
    ]));
    var groups = [['gate', 'Sites (signed-out visit)'], ['public', 'overyondr.com'], ['deploy', 'Deploys'], ['cloudflare', 'Cloudflare setup'], ['usage', 'Usage today']];
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
            h('span', { text: i.alerted ? 'People were alerted' : 'No alert sent (muted or switched off)' })])]),
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
    var rows = p.events.map(function (e) {
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
      h('label', { class: 'check' }, [active, 'Active (untick to pause all their alerts; owners still get site down / exposed)']),
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
    var all = h('input', { type: 'checkbox', id: 'af-all', checked: S.afAll, onchange: function () { S.afAll = all.checked; load(); } });
    return h('div', {}, [head('Auto-fixes', 'Every feedback item the feedback tool reports is triaged here. Only objective bugs are fixed automatically (critical ones straight away, the others queued); subjective ones wait for a person. Every step is logged, and any merged fix can be reverted with one click.'),
      h('div', { class: 'banner' + (d.config.autofix_enabled ? '' : ' red'), text: d.config.autofix_enabled ? 'The auto-fix engine is allowed to work (Settings): up to ' + d.config.autofix_max_per_hour + ' queued fixes an hour, critical ones straight away.' : 'The auto-fix engine is switched off (Settings): bugs are triaged and queued, nothing starts. Reverting still works.' }),
      h('p', {}, [all, h('label', { for: 'af-all', text: ' Also show items that are not bugs (rejected)' })]),
      rows.length ? h('div', { class: 'list' }, rows) : h('div', { class: 'empty', text: 'Nothing here yet. Feedback appears once the feedback tool reports it.' })]);
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
    var audit = d.audit.map(function (a) { return h('tr', {}, [h('td', { text: when(a.created_at) }), h('td', { text: a.actor }), h('td', { text: a.action }), h('td', { class: 'small', text: a.detail === '{}' ? '' : a.detail })]); });
    return h('div', {}, [head('Settings', isOwner() ? 'Kill switches and retention. Changes are logged.' : 'Only owners can change these.'),
      h('div', { class: 'card form' }, fields.concat(isOwner() ? [h('div', {}, [btn('Save settings', save, 'primary')])] : [])),
      h('h2', { class: 'group', text: 'Secrets and connections' }),
      h('div', { class: 'tablewrap' }, [h('table', {}, [h('tbody', {}, secrets)])]),
      h('p', { class: 'small muted', text: 'Values are never shown. Set them with `npx wrangler secret put NAME` (README "Secrets").' }),
      h('h2', { class: 'group', text: 'Audit log' }),
      audit.length ? h('div', { class: 'tablewrap' }, [h('table', {}, [h('thead', {}, [h('tr', {}, ['When', 'Who', 'What', 'Details'].map(function (t) { return h('th', { scope: 'col', text: t }); }))]), h('tbody', {}, audit)])])
        : h('p', { class: 'muted', text: 'Nothing yet.' })]);
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

  // ------------------------------------------------------------- loading
  var LOADERS = {
    status: function () { return api('status').then(viewStatus); },
    incidents: function () { return api('incidents').then(viewIncidents); },
    alerts: function () { return Promise.all([api('people'), api('alerts')]).then(function (r) { S.data.people = r[0]; return viewAlerts({ people: r[0], log: r[1] }); }); },
    backups: function () { return api('backups').then(viewBackups); },
    autofix: function () { return Promise.all([api('autofix' + (S.afAll ? '' : '?status=active')), api('autofix/config')]).then(function (r) { return viewAutofix({ autofixes: r[0].autofixes, config: r[1] }); }); },
    settings: function () { return api('settings').then(viewSettings); },
  };
  function load() {
    var view = S.view;
    return LOADERS[view]().then(function (el) { if (S.view === view) shell(el); }).catch(function (er) { shell(h('div', { class: 'banner red', role: 'alert', text: er.message })); });
  }
  function denied() {
    app.replaceChildren(h('div', { class: 'denied' }, [h('div', {}, [h('img', { src: '/brand/yondr-lichen.svg', alt: 'Yondr', width: '110' }),
      h('h1', { text: 'Admins only' }), h('p', { text: 'You are signed in as ' + S.me.email + ', who is not an admin. Ops uses the same admin list as the feedback tool: ask an owner to add you there (People).' }),
      h('p', {}, [h('a', { href: 'https://auth.overyondrdev.com/logout?return=' + encodeURIComponent(location.origin + '/') }, ['Sign in as someone else'])])])]));
  }

  function start() {
    var hash = location.hash.replace('#', '');
    var parts = hash.split('/');
    if (LOADERS[parts[0]]) S.view = parts[0];
    api('me').then(function (me) {
      S.me = me;
      if (!me.role) return denied();
      loading();
      return load().then(function () { if (parts[0] !== 'autofix') return;
        if (parts[1] === 'feedback' && parts[2]) openAutofixByFeedback(Number(parts[2])); // link from the feedback admin
        else if (parts[1]) openAutofix(Number(parts[1]));
      });
    }).catch(function (er) { app.replaceChildren(h('div', { class: 'denied' }, [h('div', {}, [h('h1', { text: 'Can\'t load' }), h('p', { text: er.message })])])); });
  }
  window.addEventListener('hashchange', function () { var v = location.hash.replace('#', '').split('/')[0]; if (LOADERS[v] && v !== S.view) { S.view = v; load(); } });
  setInterval(function () { if (S.view === 'status' && !S.drawer && !document.querySelector('dialog') && document.visibilityState === 'visible') load(); }, 60000);
  start();
})();
