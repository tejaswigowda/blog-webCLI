import { ANIMATION_NAMES } from '../vendor/animate/animate.esm.js';

export const DEFAULT_SLIDE_ANIMATION = 'fadeIn';
export const SLIDE_ANIMATIONS = ['none', ...ANIMATION_NAMES.filter((name) => !/Out|^hinge$/.test(name))];
