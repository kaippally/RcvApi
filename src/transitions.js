// The RCV addresses a transition as a category + a variant ("data"). Fade is the
// only one with no variant; dip and every wipe need both messages sent.
export const TRANSITIONS = {
  fade:        { title: 'Fade',          category: 'fade', data: null },
  dipBlack:    { title: 'Dip to Black',  category: 'dip',  data: 'dipBlack' },
  diagonal_1:  { title: 'Diagonal Left', category: 'wipe', data: 'diagonal_1' },
  diagonal_2:  { title: 'Diagonal Right',category: 'wipe', data: 'diagonal_2' },
  leftright:   { title: 'Horizontal',    category: 'wipe', data: 'leftright' },
  top_bottom:  { title: 'Vertical',      category: 'wipe', data: 'top_bottom' },
  box_tl:      { title: 'Box Top Left',  category: 'wipe', data: 'box_tl' },
  box_tr:      { title: 'Box Top Right', category: 'wipe', data: 'box_tr' },
  box_br:      { title: 'Box Bottom Right', category: 'wipe', data: 'box_br' },
  box_bl:      { title: 'Box Bottom Left',  category: 'wipe', data: 'box_bl' },
  corners:     { title: 'Corners',       category: 'wipe', data: 'corners' },
  'barndoor-v':{ title: 'Barn Door Vertical',   category: 'wipe', data: 'barndoor-v' },
  'barndoor-h':{ title: 'Barn Door Horizontal', category: 'wipe', data: 'barndoor-h' },
};

export const MAX_TRANSITION_MS = 60000;

// Per-model bank counts. The S and Core expose 5 input and 5 scene/media banks
// (physical buttons 1-5 and 8-11,14); the full RCV exposes 7 of each.
export const MODEL_LIMITS = {
  0: { name: 'RØDECaster Video',      inputs: 7, scenes: 7, media: 7, overlays: 7 },
  1: { name: 'RØDECaster Video S',    inputs: 5, scenes: 5, media: 5, overlays: 5 },
  2: { name: 'RØDECaster Video Core', inputs: 5, scenes: 5, media: 5, overlays: 5 },
};
