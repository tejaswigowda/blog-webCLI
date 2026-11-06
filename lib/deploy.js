// Where a publish is on its way to readers, from what GitHub reports about the Pages build. Pure: the
// caller fetches `GET /repos/{owner}/{repo}/pages/builds/latest` and supplies the clock, so the states
// can be tested without a network.
//   committed -> building -> live (m:ss)         or  failed (with GitHub's own reason)
//   unknown: the token cannot read Pages, or Pages is not on, so nothing can be said
export const POLL_MS = 3000;
export const GIVE_UP_MS = 15 * 60 * 1000;
export const STALLED_MS = 3 * 60 * 1000; // committed, and still no build: GitHub is probably not building
const SKEW_MS = 5000;

const when = (s) => (s ? Date.parse(s) : NaN);

// raw: the Pages builds API object, or null when there is none yet
export function parseBuild(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    status: String(raw.status || ''),
    commit: raw.commit || '',
    createdAt: when(raw.created_at),
    updatedAt: when(raw.updated_at),
    error: (raw.error && raw.error.message) || '',
  };
}

// sha: the commit that was just made; since: when (ms) it was made.
// A build is "ours" when it is for that commit, or started after it (it then carries our commit too).
export function deployState({ build, sha, since, now }) {
  const b = parseBuild(build);
  const elapsed = Math.max(0, (now - since) / 1000);
  const ours = b && (b.commit === sha || (Number.isFinite(b.createdAt) && b.createdAt >= since - SKEW_MS));
  if (!ours) return { state: 'committed', seconds: elapsed, stalled: now - since > STALLED_MS };
  if (b.status === 'errored') return { state: 'failed', seconds: elapsed, error: b.error || 'GitHub did not say why.' };
  if (b.status === 'built') return { state: 'live', seconds: Math.max(0, ((Number.isFinite(b.updatedAt) ? b.updatedAt : now) - since) / 1000) };
  return { state: 'building', seconds: elapsed };
}

export const fmtClock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// getBuild() resolves to the raw build, or null (no build yet); it rejects with an error that has .status.
// onState gets every tick, so a clock can advance; polling ends on live, failed or unknown.
export async function pollDeploy({ getBuild, sha, since, onState, sleep = sleepMs, now = Date.now, intervalMs = POLL_MS, giveUpMs = GIVE_UP_MS, signal }) {
  for (;;) {
    if (signal && signal.aborted) return null;
    let build = null;
    try {
      build = await getBuild();
    } catch (e) {
      if (e && (e.status === 403 || e.status === 401)) {
        const out = { state: 'unknown', reason: 'The token cannot read GitHub Pages builds (it needs "Pages: Read-only"), so the state of the deployment cannot be shown.' };
        onState(out);
        return out;
      }
      if (e && e.status === 404) build = null; // Pages not built yet, or not on
      else if (now() - since > giveUpMs) throw e;
    }
    const st = deployState({ build, sha, since, now: now() });
    onState(st);
    if (st.state === 'live' || st.state === 'failed') return st;
    if (now() - since > giveUpMs) {
      const out = { state: 'unknown', reason: 'GitHub has not reported a finished build after 15 minutes.' };
      onState(out);
      return out;
    }
    await sleep(intervalMs);
  }
}
