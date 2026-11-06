// The generator is synchronous and runs no extension code; when it reports missing extension
// outputs, this loop asks a `runner` for them and tries again. In the app the runner is the
// sandbox (app/sandbox.js). The CLI and CI pass no runner, so they refuse instead of running anything.
import { Refusal } from './errors.js';
import { MAX_OUTPUT } from './extensions.js';
import { buildSite } from './blog.js';

// runner({ extension, hook, ctx, input }) -> Promise<string>
export async function buildSiteWith(args, runner, { maxPasses = 12 } = {}) {
  const outputs = { ...(args.outputs || {}) };
  for (let pass = 0; pass < maxPasses; pass++) {
    const result = buildSite({ ...args, outputs });
    if (!result.missing.length) return result;
    if (!runner) return result;
    for (const m of result.missing) {
      const ext = args.extensions[m.index];
      let out;
      try {
        out = await runner({ extension: ext, hook: m.hook, ctx: m.ctx, input: m.input });
      } catch (e) {
        throw e instanceof Refusal ? e : new Refusal('extension-failed', `${ext.manifest.name} (${m.hook}): ${e.message || e}`);
      }
      if (typeof out !== 'string' || out.length > MAX_OUTPUT) throw new Refusal('extension-failed', `${ext.manifest.name} (${m.hook}) must return text under ${MAX_OUTPUT} characters`);
      outputs[m.key] = { extension: m.extension, hook: m.hook, output: out };
    }
  }
  throw new Refusal('extension-failed', `extensions did not settle after ${maxPasses} passes`);
}
