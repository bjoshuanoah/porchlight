/** Minimal self-contained mobile-web bootstrap page (bring-up scope, no CDN). */
export function bootstrapPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>porchlight — hub setup</title>
<style>
  :root { font-family: -apple-system, system-ui, sans-serif; }
  body { margin: 0; background: #0f1115; color: #e8e8ea; }
  main { max-width: 34em; margin: 0 auto; padding: 1.2em; }
  h1 { font-size: 1.25em; } fieldset { border: 1px solid #333; border-radius: 8px; margin: 0 0 1em; }
  legend { padding: 0 .5em; font-weight: 600; }
  label { display: block; margin: .6em 0 .2em; font-size: .85em; color: #aaa; }
  input, button { font-size: 1em; padding: .5em .7em; border-radius: 6px; border: 1px solid #444;
    background: #161a22; color: inherit; width: 100%; box-sizing: border-box; }
  button { margin-top: .6em; background: #2f6fed; border: 0; font-weight: 600; cursor: pointer; }
  #state { font-size: .8em; color: #9aa; white-space: pre-wrap; word-break: break-all; }
  .ok { color: #7ad97a; } .bad { color: #ef6f6f; }
</style>
</head>
<body>
<main>
<h1>porchlight hub setup</h1>
<div id="state">loading…</div>
<fieldset><legend>Step 1 — first account</legend>
  <p style="font-size:.8em;color:#9aa">Create the owner account here, or adopt an identity you already hold on another hub.</p>
  <label for="name">Display name</label><input id="name" placeholder="Owner">
  <label for="email">Email (optional)</label><input id="email" type="email">
  <button onclick="createAccount()">Create account</button>
  <label for="hub">Adopt instead: your other hub URL</label><input id="hub" placeholder="https://other-hub.example">
  <label for="extid">Your identity id on that hub</label><input id="extid" placeholder="ident_…">
  <button onclick="adoptIdentity()">Adopt identity</button>
</fieldset>
<fieldset><legend>Step 2 — hub network</legend>
  <label for="net">Network name</label><input id="net" placeholder="Family">
  <button onclick="createNetwork()">Create network</button>
</fieldset>
<fieldset><legend>Step 3 — first invite</legend>
  <button onclick="issueInvite()">Issue join-link invite</button>
</fieldset>
<fieldset><legend>Step 4 — quota ceilings (optional)</legend>
  <label for="qstore">Storage ceiling (MB)</label><input id="qstore" inputmode="numeric" placeholder="unlimited">
  <label for="qret">Retention window (days)</label><input id="qret" inputmode="numeric" placeholder="unlimited">
  <button onclick="setQuotas()">Save quota settings</button>
</fieldset>
</main>
<script>
const api = (path, init) => fetch('/api' + path, { headers: { 'content-type': 'application/json' }, ...init });
const say = (msg, bad) => { const el = document.getElementById('state'); el.textContent += (el.textContent ? '\\n' : '') + msg; };
async function createAccount() {
  const body = { displayName: document.getElementById('name').value || null, email: document.getElementById('email').value || null };
  const r = await api('/identity/bootstrap/account', { method: 'POST', body: JSON.stringify(body) });
  say((r.status === 409 ? 'account exists: ' : 'account: ') + JSON.stringify(await r.json()));
}
async function adoptIdentity() {
  const body = { sourceHubUrl: document.getElementById('hub').value, externalIdentityId: document.getElementById('extid').value };
  const r = await api('/identity/bootstrap/adopt', { method: 'POST', body: JSON.stringify(body) });
  const j = await r.json();
  say('adoption: ' + (j.error || (j.account ? 'accepted (' + j.account.kind + ')' : JSON.stringify(j))));
}
async function createNetwork() {
  const r = await api('/social/bootstrap/network', { method: 'POST', body: JSON.stringify({ name: document.getElementById('net').value }) });
  const j = await r.json();
  say('network: ' + (j.error || (j.created ? 'created' : 'already exists') + ' ' + (j.network ? j.network._id : '')));
}
async function issueInvite() {
  const r = await api('/social/bootstrap/invite', { method: 'POST', body: JSON.stringify({}) });
  const j = await r.json();
  say('invite: ' + (j.error ? (r.status === 409 && j.error.includes('network') ? 'create the network first' : j.error) : JSON.stringify(j.invite)) + (j.joinUrl ? '\\njoin link: ' + j.joinUrl : ''));
}
async function setQuotas() {
  const s = document.getElementById('qstore').value, d = document.getElementById('qret').value;
  const body = { storageCeilingMb: s ? Number(s) : null, retentionDays: d ? Number(d) : null };
  const r = await api('/bootstrap/quotas', { method: 'POST', body: JSON.stringify(body) });
  const j = await r.json();
  say('quota settings: ' + (j.error ? j.error : JSON.stringify(j.quota)));
}
async function refresh() {
  const r = await fetch('/api/bootstrap/state');
  const j = await r.json();
  const bad = j.lastError ? ' LAST ERROR: ' + j.lastError : '';
  say('steps: ' + Object.entries(j.steps).map(([k, v]) => k + '=' + v.status).join(', ') + bad);
}
refresh();
</script>
</body>
</html>`;
}