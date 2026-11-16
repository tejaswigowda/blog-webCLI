// Only the live bundle substitutes this module for the synchronous publish-time renderer.
import { Refusal } from './errors.js';
import { MATH_ID } from './math-syntax.js';
import { mathState } from './math-state.js';

let loading;
export async function loadMath() {
  if (mathState.render) return;
  if (!loading) loading = import(new URL('./webcli-math.js', import.meta.url).href).then((module) => {
    if (module.MATH_ID !== MATH_ID) throw new Refusal('bad-math', `Math renderer mismatch: expected ${MATH_ID}, received ${module.MATH_ID}.`);
    mathState.render = module.renderMath;
  });
  await loading;
}

export function renderMath(tex, opts) {
  if (!mathState.render) throw new Refusal('bad-math', 'The live math renderer has not been loaded.');
  return mathState.render(tex, opts);
}
